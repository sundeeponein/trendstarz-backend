import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import type { Connection } from "mongoose";
import { IntegrityCheck, runIntegrityChecks } from "./integrity-checks";
import { sendAppEmail } from "../utils/app-email.service";

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

  /** Latest stored run; runs the checks first if there has never been one. */
  async report(): Promise<IntegrityRun> {
    return (await this.latest()) || this.run("admin");
  }

  @Cron("45 2 * * *", { timeZone: "Asia/Kolkata", name: "dataIntegrityNightly" })
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
