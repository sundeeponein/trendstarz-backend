import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { SingleInstance } from "../utils/single-instance";
import { WhatsAppService } from "./whatsapp.service";
import { isWhatsAppTemplateEnabled } from "./whatsapp-templates";

const HOUR = 60 * 60 * 1000;
/** Only accounts this new get a welcome — turning WhatsApp on never messages old users. */
export const WELCOME_WINDOW_MS = 48 * HOUR;
/** Mobile reminder: once, between 24h and 72h after signup, if still unverified. */
export const MOBILE_REMINDER_AFTER_MS = 24 * HOUR;
export const MOBILE_REMINDER_UNTIL_MS = 72 * HOUR;
const PER_RUN = 200;

type Role = "influencer" | "brand" | "photographer";

const PROFILE_PAGE: Record<Role, string> = {
  influencer: "/influencer-profile",
  brand: "/brand-profile",
  photographer: "/photographer-profile",
};

/**
 * Automatic WhatsApp after signup: a welcome, and one "verify your mobile"
 * reminder a day later if the number is still unverified. Both go to the number
 * on file (the welcome is how a new user learns the number is right), respect
 * the WhatsApp opt-out, and are stamped only once actually delivered.
 */
@Injectable()
export class WhatsAppLifecycleService {
  private readonly logger = new Logger(WhatsAppLifecycleService.name);

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  private models(): Array<[Role, Model<any>]> {
    return [
      ["influencer", this.influencerModel],
      ["brand", this.brandModel],
      ["photographer", this.photographerModel],
    ];
  }

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || "https://trendstarz.in").replace(/\/+$/, "");
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  @SingleInstance()
  async runCron() {
    try {
      await this.sendWelcomes();
      await this.sendMobileReminders();
    } catch (e: any) {
      this.logger.warn(`WhatsApp lifecycle run failed: ${e?.message || e}`);
    }
  }

  private live() {
    return {
      isDeleted: { $ne: true },
      anonymized: { $ne: true },
      status: { $nin: ["deleted", "deletion_pending", "declined"] },
      phoneNumber: { $type: "string", $ne: "" },
    };
  }

  async sendWelcomes(now = new Date()): Promise<number> {
    if (!isWhatsAppTemplateEnabled("welcome_user")) return 0;
    let sent = 0;
    for (const [role, model] of this.models()) {
      const people = await model
        .find({
          ...this.live(),
          welcomeWhatsappSentAt: null,
          createdAt: { $gte: new Date(now.getTime() - WELCOME_WINDOW_MS) },
        })
        .select("_id name brandName contactPersonName phoneNumber")
        .limit(PER_RUN)
        .lean();
      for (const p of people as any[]) {
        const result = await this.whatsAppService.sendVerificationNudge(String(p._id), p.phoneNumber, {
          name: "welcome_user",
          bodyParams: [p.name || p.contactPersonName || p.brandName || "there", `${this.frontendUrl()}${PROFILE_PAGE[role]}`],
        });
        if (result.sent) {
          await model.updateOne({ _id: p._id, welcomeWhatsappSentAt: null }, { $set: { welcomeWhatsappSentAt: new Date() } });
          sent++;
        }
      }
    }
    return sent;
  }

  async sendMobileReminders(now = new Date()): Promise<number> {
    if (!isWhatsAppTemplateEnabled("mobile_otp_verification_reminder", { newUse: true })) return 0;
    let sent = 0;
    for (const [, model] of this.models()) {
      const people = await model
        .find({
          ...this.live(),
          isMobileVerified: { $ne: true },
          mobileReminderWhatsappSentAt: null,
          createdAt: {
            $gte: new Date(now.getTime() - MOBILE_REMINDER_UNTIL_MS),
            $lte: new Date(now.getTime() - MOBILE_REMINDER_AFTER_MS),
          },
        })
        .select("_id name brandName contactPersonName phoneNumber")
        .limit(PER_RUN)
        .lean();
      for (const p of people as any[]) {
        const result = await this.whatsAppService.sendVerificationNudge(String(p._id), p.phoneNumber, {
          name: "mobile_otp_verification_reminder",
          bodyParams: [p.name || p.contactPersonName || p.brandName || "there", String(p.phoneNumber)],
          newUse: true,
        });
        if (result.sent) {
          await model.updateOne({ _id: p._id, mobileReminderWhatsappSentAt: null }, { $set: { mobileReminderWhatsappSentAt: new Date() } });
          sent++;
        }
      }
    }
    return sent;
  }
}
