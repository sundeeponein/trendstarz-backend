import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendWhatsAppTemplateMessage } from "../utils/whatsapp-cloud-api.util";
import { isWhatsAppTemplateEnabled, whatsAppParam } from "./whatsapp-templates";

export type WhatsAppTemplateName =
  | "campaign_approved_owner"
  | "campaign_new_match_open"
  | "campaign_new_match_invite"
  | "campaign_invite_accepted_owner"
  | "campaign_post_submitted_owner"
  | "campaign_posting_reminder"
  | "email_verification_reminder"
  | "profile_photo_not_verified"
  | "mobile_otp_verification_reminder"
  | "mobile_verification_call_reminder"
  // Added for account, Premium and campaign-money events (whatsapp-templates.ts).
  | "welcome_user"
  | "premium_activated"
  | "campaign_payment_received_host"
  | "campaign_start_posting"
  | "campaign_post_approved"
  | "campaign_changes_requested"
  | "campaign_submission_under_review";

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @InjectModel("NotificationPreference")
    private readonly preferenceModel: Model<any>,
  ) {}

  private async isAllowed(userId: string): Promise<boolean> {
    const pref: any = await this.preferenceModel
      .findOne({ userId: String(userId) })
      .select("whatsappEnabled")
      .lean();
    return pref?.whatsappEnabled ?? true;
  }

  private async deliver(
    userId: string,
    phoneNumber: string,
    template: { name: WhatsAppTemplateName; bodyParams: string[]; newUse?: boolean },
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!isWhatsAppTemplateEnabled(template.name, { newUse: template.newUse })) {
      return { sent: false, reason: `Template "${template.name}" is not switched on (WHATSAPP_TEMPLATES)` };
    }
    const allowed = await this.isAllowed(userId);
    if (!allowed) {
      return { sent: false, reason: "User opted out of WhatsApp notifications" };
    }
    try {
      const result = await sendWhatsAppTemplateMessage({
        to: phoneNumber,
        templateName: template.name,
        bodyParams: template.bodyParams.map((p) => whatsAppParam(p)),
      });
      if ((result as any)?.skipped) {
        return { sent: false, reason: (result as any).reason };
      }
      return { sent: true };
    } catch (err: any) {
      this.logger.warn(
        `Failed to send WhatsApp template "${template.name}" to user ${userId}: ${err?.message || err}`,
      );
      return { sent: false, reason: "Send failed" };
    }
  }

  /**
   * Sends a pre-approved WhatsApp template message to a user, honoring their
   * account-level opt-out and requiring a verified mobile number. Best-effort:
   * callers should not let a failure here block the surrounding flow.
   */
  async sendToUser(
    userId: string,
    phoneNumber: string | undefined | null,
    isMobileVerified: boolean | undefined,
    template: { name: WhatsAppTemplateName; bodyParams: string[] },
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!isMobileVerified || !phoneNumber) {
      return { sent: false, reason: "No verified mobile number" };
    }
    return this.deliver(userId, phoneNumber, template);
  }

  /**
   * Admin-initiated manual verification nudge — deliberately does NOT
   * require isMobileVerified, since the whole point is reaching a number
   * that isn't verified yet (admin couldn't get through by call). Still
   * respects the account's WhatsApp opt-out preference.
   */
  async sendVerificationNudge(
    userId: string,
    phoneNumber: string | undefined | null,
    template: { name: WhatsAppTemplateName; bodyParams: string[]; newUse?: boolean },
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!phoneNumber) {
      return { sent: false, reason: "No phone number on file" };
    }
    return this.deliver(userId, phoneNumber, template);
  }
}
