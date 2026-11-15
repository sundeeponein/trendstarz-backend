import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { reactivationEmailTemplate } from "../email/templates/reactivation.templates";
import { sendAppEmail } from "../utils/app-email.service";
import { fetchBlockedContacts } from "../data-integrity/email-blocks";
import { getJwtSecret } from "../auth/jwt-secret";
import { applyApprovedActiveAccountFilter } from "../utils/profile-eligibility.util";
import { OFFER_EMAIL_SENDS, DEFAULT_SEND_LIMIT } from "../plans/offer-email.service";
import { offerUnsubscribeToken } from "../plans/offer-email.util";

/**
 * Matching 3E (2026-11-15): one "come back, check your rates and availability"
 * email to approved creators not seen in over 90 days. Admin-pressed only, once
 * per creator (rows in offer_email_sends under REACTIVATION_SEND_KEY, unique per
 * person), same opt-out flag and unsubscribe link as the offer emails, Brevo-
 * blocked addresses skipped, capped per press under Brevo's free 300/day.
 */
export const REACTIVATION_SEND_KEY = "reactivation-v1";
export const DORMANT_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_MS = 150;

type Role = "influencer" | "photographer";
const COLLECTIONS: Array<[Role, string]> = [
  ["influencer", "influencers"],
  ["photographer", "photographers"],
];
const PROFILE_PAGE: Record<Role, string> = {
  influencer: "/influencer-profile",
  photographer: "/photographer-profile",
};

/** Approved, active creators with no login or app open in the last 90 days (never = dormant too). */
export function reactivationAudienceFilter(now: Date = new Date()): Record<string, any> {
  const cut = new Date(now.getTime() - DORMANT_AFTER_DAYS * DAY_MS);
  const filter = applyApprovedActiveAccountFilter({
    anonymized: { $ne: true },
    offerEmailsOptOut: { $ne: true },
    email: { $type: "string", $regex: /@/ },
  });
  filter.$and.push(
    { $or: [{ lastLoginAt: null }, { lastLoginAt: { $lt: cut } }] },
    { $or: [{ lastOpenedAt: null }, { lastOpenedAt: { $lt: cut } }] },
  );
  return filter;
}

export interface ReactivationProgress {
  startedAt: Date;
  finishedAt: Date | null;
  sent: number;
  failed: number;
  skippedBlocked: number;
  /** Logged in since the list was built — no longer dormant. */
  skippedActive: number;
  stoppedReason: string;
}

@Injectable()
export class ReactivationEmailService {
  private running: ReactivationProgress | null = null;
  private indexReady: Promise<unknown> | null = null;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private sends() {
    const col = this.connection.collection(OFFER_EMAIL_SENDS);
    this.indexReady ??= col
      .createIndex({ offerKey: 1, userId: 1 }, { unique: true })
      .catch(() => (this.indexReady = null));
    return col;
  }

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || "https://trendstarz.in").replace(/\/+$/, "");
  }

  private render(role: Role, person: { _id: any; name?: string }) {
    return reactivationEmailTemplate({
      recipientName: String(person.name || "there").trim() || "there",
      profileUrl: `${this.frontendUrl()}${PROFILE_PAGE[role]}`,
      unsubscribeUrl: `${this.frontendUrl()}/offer-emails/unsubscribe?t=${encodeURIComponent(
        offerUnsubscribeToken(role, String(person._id), getJwtSecret()),
      )}`,
    });
  }

  private async sentIds(onlySent = false): Promise<string[]> {
    const ids = await this.sends().distinct(
      "userId",
      onlySent ? { offerKey: REACTIVATION_SEND_KEY, status: "sent" } : { offerKey: REACTIVATION_SEND_KEY },
    );
    return ids.map((id) => String(id));
  }

  async preview() {
    const now = new Date();
    const sent = new Set(await this.sentIds(true));
    let dormant = 0;
    let notYetSent = 0;
    for (const [, col] of COLLECTIONS) {
      const ids = await this.connection
        .collection(col)
        .find(reactivationAudienceFilter(now), { projection: { _id: 1 } })
        .toArray();
      dormant += ids.length;
      notYetSent += ids.filter((d) => !sent.has(String(d._id))).length;
    }
    const sample = this.render("influencer", { _id: "000000000000000000000000", name: "Creator" });
    return {
      success: true,
      dormantAfterDays: DORMANT_AFTER_DAYS,
      dormant,
      alreadySent: sent.size,
      notYetSent,
      subject: sample.subject,
      html: sample.html,
      sendLimit: DEFAULT_SEND_LIMIT,
      progress: this.running,
    };
  }

  async sendTest(to: unknown) {
    const address = String(to || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new BadRequestException("Enter a valid email address.");
    const mail = this.render("influencer", { _id: "000000000000000000000000", name: "Creator" });
    await sendAppEmail({ to: address, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
    return { success: true, to: address };
  }

  /** Starts sending in the background and returns straight away; preview() shows progress. */
  async sendAll(limitInput: unknown) {
    if (this.running && !this.running.finishedAt) throw new BadRequestException("This email is already being sent.");
    const limit = Math.min(Math.max(Math.floor(Number(limitInput) || DEFAULT_SEND_LIMIT), 1), 2000);
    const progress: ReactivationProgress = {
      startedAt: new Date(),
      finishedAt: null,
      sent: 0,
      failed: 0,
      skippedBlocked: 0,
      skippedActive: 0,
      stoppedReason: "",
    };
    this.running = progress;
    void this.runSend(limit, progress).catch((err) => {
      progress.stoppedReason = String(err?.message || err).slice(0, 200);
      progress.finishedAt = new Date();
    });
    return { success: true, started: true, limit };
  }

  private async runSend(limit: number, progress: ReactivationProgress) {
    const sends = this.sends();
    await this.indexReady;
    const already = new Set(await this.sentIds());

    let blocked = new Set<string>();
    if (process.env.BREVO_API_KEY) {
      try {
        blocked = new Set(
          (await fetchBlockedContacts(process.env.BREVO_API_KEY)).map((b) => String(b.email || "").trim().toLowerCase()),
        );
      } catch {
        // Brevo itself refuses blocked addresses; the list only saves wasted calls.
      }
    }

    outer: for (const [role, colName] of COLLECTIONS) {
      const col = this.connection.collection(colName);
      const people = await col
        .find(
          reactivationAudienceFilter(),
          { projection: { _id: 1, name: 1, email: 1 } },
        )
        .sort({ _id: 1 })
        .toArray();
      for (const person of people as any[]) {
        const userId = String(person._id);
        if (already.has(userId)) continue;
        if (progress.sent >= limit) {
          progress.stoppedReason = `Reached this send's limit of ${limit}. Press Send again (e.g. tomorrow) for the rest.`;
          break outer;
        }
        const email = String(person.email || "").trim().toLowerCase();
        if (blocked.has(email)) {
          progress.skippedBlocked++;
          continue;
        }
        // They may have logged in (or opted out) since the list was built.
        if (!(await col.findOne({ ...reactivationAudienceFilter(), _id: person._id }, { projection: { _id: 1 } }))) {
          progress.skippedActive++;
          continue;
        }
        try {
          await sends.insertOne({ offerKey: REACTIVATION_SEND_KEY, userId, role, kind: "reactivation", status: "sending", at: new Date() });
        } catch {
          continue; // Already sent (or being sent) to this person.
        }
        try {
          const mail = this.render(role, person);
          await sendAppEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
          await sends.updateOne({ offerKey: REACTIVATION_SEND_KEY, userId }, { $set: { status: "sent", sentAt: new Date() } });
          progress.sent++;
        } catch (err: any) {
          await sends.deleteOne({ offerKey: REACTIVATION_SEND_KEY, userId });
          progress.failed++;
          // A quota or key problem fails every following send too.
          if (/HTTP (401|402|403|429)/.test(String(err?.message || "")) || progress.failed >= 5) {
            progress.stoppedReason = `Stopped after send errors: ${String(err?.message || "error").slice(0, 160)}`;
            break outer;
          }
        }
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
    }
    progress.finishedAt = new Date();
  }
}
