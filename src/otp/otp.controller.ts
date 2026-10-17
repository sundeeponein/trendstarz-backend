import {
  Controller,
  Post,
  Body,
  Inject,
} from "@nestjs/common";
import { otpTemplate } from "../email/templates/otp.templates";
import { sendAppEmail } from "../utils/app-email.service";
import type { SmsProvider } from "../services/smsProvider.service";
import { OTP_TTL_MS, OtpStoreService } from "./otp-store.service";

/**
 * Email/phone OTP. Codes (hashed), attempt counts, send rate limits and the
 * one-time verification tokens live in MongoDB via OtpStoreService — so they
 * survive deploys and work across server instances.
 */
@Controller("otp")
export class OtpController {
  constructor(
    @Inject("SMS_PROVIDER") private readonly smsProvider: SmsProvider,
    private readonly otpStore: OtpStoreService,
  ) {}

  @Post("send")
  async sendOtp(@Body() body: any) {
    const { type, value } = body || {};
    if (!type || !value) {
      return { error: "Missing type or value" };
    }
    const otp = await this.otpStore.issueCode(value);
    const minutes = OTP_TTL_MS / 60 / 1000;
    if (type === "email") {
      const template = otpTemplate({ otp, expiryMinutes: minutes });
      await sendAppEmail({
        to: value,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });
    } else if (type === "phone") {
      await this.smsProvider.send(
        value,
        `Your TrendStarz OTP is ${otp}. It expires in ${minutes} minutes.`,
      );
    }
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Post("verify")
  async verifyOtp(@Body() body: any) {
    const { type, value, otp } = body || {};
    if (!type || !value || !otp) {
      return { error: "Missing type, value, or otp" };
    }
    const result = await this.otpStore.verifyCode(type, value, otp);
    if (!result.ok) return { error: result.error };
    return {
      message: "OTP verified successfully",
      verificationToken: result.verificationToken,
    };
  }
}
