import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import type { Connection } from "mongoose";
import {
  EXPLANATIONS,
  IntegrityCheck,
  runIntegrityChecks,
} from "./integrity-checks";

/** Checks whose findings point at one record an admin can explain. */
export const EXPLAINABLE_CHECKS = [
  "unexplained_premium",
  "unpaid_unlocks",
  "premium_sources_agree",
  "invite_payment_agree",
  "money_adds_up",
  "utr_used_twice",
];
import { sendAppEmail } from "../utils/app-email.service";
import { SingleInstance } from "../utils/single-instance";

const RUNS = "data_integrity_runs";
const KEEP_DAYS = 180;

export interface IntegrityRun {
  ranAt: Date;
  trigger: "nightly" | "admin";
  warnCount: number;
  checks: IntegrityCheck[];
}

/** Fingerprint of what is wrong, so a repeat of the same result doesn't re-alert. */
export function warningSignature(checks: IntegrityCheck[]): string {
  return checks
    .filter((c) => c.status === "warn")
    .map((c) => `${c.key}:${c.count}`)
    .sort()
    .join("|");
}

@Injectable()
export class DataIntegrityService implements OnModuleInit {
  private readonly logger = new Logger(DataIntegrityService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onModuleInit() {
    try {
      await this.connection.db!
        .collection(EXPLANATIONS)
        .createIndex({ check: 1, ref: 1 }, { unique: true });
      await this.connection.db!
        .collection(RUNS)
        .createIndex({ ranAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 3600 });
    } catch (err: any) {
      this.logger.warn(`Could not ensure ${RUNS} TTL index: ${err?.message || err}`);
    }
  }

  /** Runs every check, stores the run and returns it. */
  async run(trigger: IntegrityRun["trigger"]): Promise<IntegrityRun> {
    const checks = await runIntegrityChecks(this.connection.db as any);
    const run: IntegrityRun = {
      ranAt: new Date(),
      trigger,
      warnCount: checks.filter((c) => c.status === "warn").length,
      checks,
    };
    await this.connection.db!.collection(RUNS).insertOne({ ...run });
    return run;
  }

  async latest(): Promise<IntegrityRun | null> {
    return (await this.connection
      .db!.collection(RUNS)
      .find({}, { projection: { _id: 0 } })
      .sort({ ranAt: -1 })
      .limit(1)
      .next()) as IntegrityRun | null;
  }

  /**
   * An admin explains one finding (e.g. "settled outside the app in June 2026").
   * The record itself is left untouched — the explanation is kept separately,
   * with who/when, and the check stops counting that record.
   */
  async explain(
    input: { check?: string; ref?: string; reason?: string },
    adminId: string,
  ): Promise<IntegrityRun> {
    const check = String(input?.check || "");
    const ref = String(input?.ref || "").trim();
    const reason = String(input?.reason || "").trim();
    if (!EXPLAINABLE_CHECKS.includes(check)) {
      throw new BadRequestException("This check can't be explained per record.");
    }
    const current = await runIntegrityChecks(this.connection.db as any);
    const finding = current.find((c) => c.key === check);
    if (!ref || !finding?.refs?.includes(ref)) {
      throw new BadRequestException("That record isn't flagged by this check (any more).");
    }
    if (reason.length < 10) {
      throw new BadRequestException("Write why this is OK (at least 10 characters).");
    }
    await this.connection.db!.collection(EXPLANATIONS).updateOne(
      { check, ref },
      { $set: { check, ref, reason, by: adminId, at: new Date() } },
      { upsert: true },
    );
    return this.run("admin");
  }

  async explanations() {
    return this.connection
      .db!.collection(EXPLANATIONS)
      .find({}, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .toArray();
  }

  /** Latest stored run; runs the checks first if there has never been one. */
  async report(): Promise<IntegrityRun> {
    return (await this.latest()) || this.run("admin");
  }

  @Cron("45 2 * * *", { timeZone: "Asia/Kolkata", name: "dataIntegrityNightly" })
  @SingleInstance()
  async nightly() {
    try {
      const previous = await this.latest();
      const run = await this.run("nightly");
      if (!run.warnCount) return;
      this.logger.warn(
        `Data integrity: ${run.warnCount} check(s) need attention — ${warningSignature(run.checks)}`,
      );
      // Alert only when what's wrong changed, not every night for the same thing.
      if (previous && warningSignature(previous.checks) === warningSignature(run.checks)) return;
      await this.alert(run);
    } catch (err: any) {
      this.logger.error(`Nightly data integrity run failed: ${err?.message || err}`);
    }
  }

  private async alert(run: IntegrityRun) {
    const to = process.env.ADMIN_EMAIL || "support@trendstarz.in";
    const url = `${process.env.FRONTEND_URL || "https://trendstarz.in"}/admin/data-health`;
    const lines = run.checks
      .filter((c) => c.status === "warn")
      .map((c) => `• ${c.label}: ${c.count}\n  ${c.help}`);
    const text = `The nightly data check found ${run.warnCount} issue(s):\n\n${lines.join("\n\n")}\n\nDetails: ${url}`;
    await sendAppEmail({
      to,
      subject: `TrendStarZ data check: ${run.warnCount} issue(s) need attention`,
      text,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</pre>`,
    }).catch((err: unknown) =>
      this.logger.error(`Data integrity alert email failed: ${String(err)}`),
    );
  }
}
