import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { computeSubscriptionPrice } from "./subscription-price.util";
import { isPlanOfferOver, planOfferEndsAt } from "./plan-offer.util";
import {
  OfferRole,
  cleanBenefits,
  defaultOfferBenefits,
  formatRupees,
  offerAudienceFilter,
  offerEndsLabel,
  offerSendKey,
  offerUnsubscribeToken,
  verifyOfferUnsubscribeToken,
} from "./offer-email.util";
import { OfferEmailKind, offerEmailTemplate } from "../email/templates/offer.templates";
import { sendAppEmail } from "../utils/app-email.service";
import { fetchBlockedContacts } from "../data-integrity/email-blocks";
import { getJwtSecret } from "../auth/jwt-secret";

/** Who got which offer email — one row per person per offer per kind (unique). */
export const OFFER_EMAIL_SENDS = "offer_email_sends";
/** Default per press: stays under Brevo's free 300/day. */
export const DEFAULT_SEND_LIMIT = 250;
const PAUSE_MS = 150;

const ROLE_BY_TYPE: Record<string, OfferRole> = {
  INFLUENCER: "influencer",
  BRAND: "brand",
  PHOTOGRAPHER: "photographer",
};

export interface SendProgress {
  startedAt: Date;
  finishedAt: Date | null;
  sent: number;
  failed: number;
  skippedBlocked: number;
  stoppedReason: string;
}

@Injectable()
export class OfferEmailService {
  /** Sends running in this process, by offer key (the server runs one instance). */
  private readonly running = new Map<string, SendProgress>();
  private indexReady: Promise<unknown> | null = null;

  constructor(
    @InjectModel("Plan") private readonly planModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  private modelFor(role: OfferRole): Model<any> {
    if (role === "brand") return this.brandModel;
    if (role === "photographer") return this.photographerModel;
    return this.influencerModel;
  }

  private sends() {
    const col = this.planModel.db.collection(OFFER_EMAIL_SENDS);
    this.indexReady ??= col
      .createIndex({ offerKey: 1, userId: 1 }, { unique: true })
      .catch(() => (this.indexReady = null));
    return col;
  }

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || "https://trendstarz.in").replace(/\/+$/, "");
  }

  private parseKind(kind: unknown): OfferEmailKind {
    if (kind === "launch" || kind === "reminder") return kind;
    throw new BadRequestException("Email type must be launch or reminder.");
  }

  /** The live plan, its role and what the email would say — or why it can't be sent. */
  private async context(planId: string, kind: OfferEmailKind, now = new Date()) {
    const plan: any = await this.planModel.findById(planId).lean();
    if (!plan) throw new NotFoundException("Plan not found");
    const role = ROLE_BY_TYPE[String(plan.userType || "").toUpperCase()] || "influencer";

    const price = computeSubscriptionPrice(plan, "yearly", null, now);
    const endsAt = planOfferEndsAt(plan);
    let blockedReason = "";
    if (!endsAt) blockedReason = 'Set "Offer Ends At" first: the email tells people when the offer ends.';
    else if (isPlanOfferOver(plan, now)) blockedReason = "This offer has already ended.";
    else if (price.discountRupees <= 0) blockedReason = "There is no yearly discount running to promote.";

    const freePlan: any = await this.planModel
      .findOne({ isActive: true, userType: plan.userType, "price.monthly": 0, "price.quarterly": 0, "price.yearly": 0 })
      .sort({ sortOrder: 1 })
      .lean();
    const settings: any = await this.appSettingsModel.findOne({}).lean();

    return {
      plan,
      role,
      kind,
      offerKey: offerSendKey(plan, kind),
      blockedReason,
      defaultBenefits: defaultOfferBenefits(plan, freePlan, settings, role),
      fields: {
        offerName: String(plan.founderOfferName || "Premium offer"),
        yearlyOfferPrice: formatRupees(price.finalRupees),
        yearlyPrice: formatRupees(price.baseRupees),
        endsAtLabel: endsAt ? offerEndsLabel(endsAt) : "",
      },
    };
  }

  private render(ctx: Awaited<ReturnType<OfferEmailService["context"]>>, person: { _id: any; name?: string }, benefits: string[]) {
    return offerEmailTemplate({
      kind: ctx.kind,
      recipientName: String(person.name || "there").trim() || "there",
      ...ctx.fields,
      benefits,
      upgradeUrl: `${this.frontendUrl()}/upgrade-premium`,
      unsubscribeUrl: `${this.frontendUrl()}/offer-emails/unsubscribe?t=${encodeURIComponent(
        offerUnsubscribeToken(ctx.role, String(person._id), getJwtSecret()),
      )}`,
    });
  }

  async preview(planId: string, kindInput: unknown, benefitsInput?: unknown) {
    const kind = this.parseKind(kindInput);
    const ctx = await this.context(planId, kind);
    const model = this.modelFor(ctx.role);
    const sentIds = await this.sends().distinct("userId", { offerKey: ctx.offerKey, status: "sent" });
    const recipients = await model.countDocuments(offerAudienceFilter());
    const notYetSent = await model.countDocuments({
      ...offerAudienceFilter(),
      _id: { $nin: sentIds },
    });
    const benefits = benefitsInput === undefined ? ctx.defaultBenefits : cleanBenefits(benefitsInput);
    const sample = this.render(ctx, { _id: "000000000000000000000000", name: "Creator" }, benefits);
    return {
      success: true,
      kind,
      role: ctx.role,
      canSend: !ctx.blockedReason,
      blockedReason: ctx.blockedReason,
      recipients,
      alreadySent: sentIds.length,
      notYetSent,
      defaultBenefits: ctx.defaultBenefits,
      benefits,
      subject: sample.subject,
      html: sample.html,
      sendLimit: DEFAULT_SEND_LIMIT,
      progress: this.running.get(ctx.offerKey) || null,
    };
  }

  async sendTest(planId: string, kindInput: unknown, to: unknown, benefitsInput: unknown) {
    const kind = this.parseKind(kindInput);
    const address = String(to || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new BadRequestException("Enter a valid email address.");
    const ctx = await this.context(planId, kind);
    if (ctx.blockedReason) throw new BadRequestException(ctx.blockedReason);
    const mail = this.render(ctx, { _id: "000000000000000000000000", name: "Creator" }, cleanBenefits(benefitsInput));
    await sendAppEmail({ to: address, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
    return { success: true, to: address };
  }

  /** Starts sending in the background and returns straight away; preview() shows progress. */
  async sendAll(planId: string, kindInput: unknown, benefitsInput: unknown, limitInput: unknown) {
    const kind = this.parseKind(kindInput);
    const ctx = await this.context(planId, kind);
    if (ctx.blockedReason) throw new BadRequestException(ctx.blockedReason);
    const current = this.running.get(ctx.offerKey);
    if (current && !current.finishedAt) throw new BadRequestException("This email is already being sent.");
    const limit = Math.min(Math.max(Math.floor(Number(limitInput) || DEFAULT_SEND_LIMIT), 1), 2000);
    const benefits = cleanBenefits(benefitsInput);

    const progress: SendProgress = { startedAt: new Date(), finishedAt: null, sent: 0, failed: 0, skippedBlocked: 0, stoppedReason: "" };
    this.running.set(ctx.offerKey, progress);
    void this.runSend(ctx, benefits, limit, progress).catch((err) => {
      progress.stoppedReason = String(err?.message || err).slice(0, 200);
      progress.finishedAt = new Date();
    });
    return { success: true, started: true, limit };
  }

  private async runSend(
    ctx: Awaited<ReturnType<OfferEmailService["context"]>>,
    benefits: string[],
    limit: number,
    progress: SendProgress,
  ) {
    const sends = this.sends();
    await this.indexReady;
    const model = this.modelFor(ctx.role);
    const sentIds = await sends.distinct("userId", { offerKey: ctx.offerKey });
    const people = await model
      .find({ ...offerAudienceFilter(), _id: { $nin: sentIds } })
      .select("_id name email")
      .sort({ lastLoginAt: -1, _id: 1 })
      .lean();

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

    for (const person of people as any[]) {
      if (progress.sent >= limit) {
        progress.stoppedReason = `Reached this send's limit of ${limit}. Press Send again (e.g. tomorrow) for the rest.`;
        break;
      }
      // The offer can end while a send is running.
      const live: any = await this.planModel.findById(ctx.plan._id).lean();
      if (!live || isPlanOfferOver(live) || offerSendKey(live, ctx.kind) !== ctx.offerKey) {
        progress.stoppedReason = "The offer ended or was changed while sending.";
        break;
      }
      const email = String(person.email || "").trim().toLowerCase();
      if (blocked.has(email)) {
        progress.skippedBlocked++;
        continue;
      }
      const userId = String(person._id);
      try {
        await sends.insertOne({ offerKey: ctx.offerKey, userId, role: ctx.role, kind: ctx.kind, status: "sending", at: new Date() });
      } catch {
        continue; // Already sent (or being sent) to this person for this offer.
      }
      try {
        const mail = this.render(ctx, person, benefits);
        await sendAppEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
        await sends.updateOne({ offerKey: ctx.offerKey, userId }, { $set: { status: "sent", sentAt: new Date() } });
        progress.sent++;
      } catch (err: any) {
        await sends.deleteOne({ offerKey: ctx.offerKey, userId });
        progress.failed++;
        // A quota or key problem fails every following send too.
        if (/HTTP (401|402|403|429)/.test(String(err?.message || "")) || progress.failed >= 5) {
          progress.stoppedReason = `Stopped after send errors: ${String(err?.message || "error").slice(0, 160)}`;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    progress.finishedAt = new Date();
  }

  /** "Stop offer emails" link — account emails (payments, invites, security) still go out. */
  async unsubscribe(token: unknown) {
    const parsed = verifyOfferUnsubscribeToken(token, getJwtSecret());
    if (!parsed) throw new BadRequestException("This link is not valid.");
    await this.modelFor(parsed.role).updateOne({ _id: parsed.id }, { $set: { offerEmailsOptOut: true } });
    return { success: true };
  }
}
