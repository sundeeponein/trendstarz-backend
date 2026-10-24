import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Inject,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { canonicalPhone } from "../utils/phone.util";
import { otpTemplate } from "../email/templates/otp.templates";
import { sendAppEmail } from "../utils/app-email.service";
import type { SmsProvider } from "../services/smsProvider.service";
import { OTP_TTL_MS, OtpStoreService } from "./otp-store.service";

/**
 * Email/phone OTP. Codes (hashed), attempt counts, send rate limits and the
 * one-time verification tokens live in MongoDB via OtpStoreService — so they
 * survive deploys and work across server instances.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Digits with an optional leading + and spaces/dashes, 10–15 digits in total. */
const PHONE_PATTERN = { test: (v: string) => /^\+?[\d\s-]+$/.test(v) && /^\d{10,15}$/.test(v.replace(/\D/g, "")) };

@Controller("otp")
export class OtpController {
  constructor(
    @Inject("SMS_PROVIDER") private readonly smsProvider: SmsProvider,
    private readonly otpStore: OtpStoreService,
  ) {}

  // Public (signup needs it) and each call sends a real email: keep it slow
  // per IP — the per-address limit alone can be dodged by changing addresses.
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post("send")
  async sendOtp(@Body() body: any) {
    const { type, value } = body || {};
    if (!type || !value) {
      return { error: "Missing type or value" };
    }
    const text = String(value).trim();
    if (type === "email" ? !EMAIL_PATTERN.test(text) || text.length > 254 : type === "phone" ? !PHONE_PATTERN.test(text) : true) {
      throw new BadRequestException(type === "phone" ? "Enter a valid mobile number" : "Enter a valid email address");
    }
    // Phones are keyed by their 10-digit form (the same form signup checks).
    const key = type === "phone" ? canonicalPhone(text) : text;
    const otp = await this.otpStore.issueCode(key);
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
        key,
        `Your TrendStarz OTP is ${otp}. It expires in ${minutes} minutes.`,
      );
    }
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post("verify")
  async verifyOtp(@Body() body: any) {
    const { type, value, otp } = body || {};
    if (!type || !value || !otp) {
      return { error: "Missing type, value, or otp" };
    }
    const result = await this.otpStore.verifyCode(
      type,
      type === "phone" ? canonicalPhone(value) : value,
      otp,
    );
    if (!result.ok) return { error: result.error };
    return {
      message: "OTP verified successfully",
      verificationToken: result.verificationToken,
    };
  }
}
