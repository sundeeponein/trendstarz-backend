import { Controller, Post, Body } from "@nestjs/common";
import { DevEmailService } from "../utils/dev-email.service";
import { SesEmailService } from "../utils/ses-email.service";
import * as crypto from "crypto";

// In-memory OTP store with expiry (replace with MongoDB/Redis in production)
const otpStore: Map<string, { otp: string; expires: number }> = new Map();

@Controller("otp")
export class OtpController {
  constructor(
    private readonly devEmailService: DevEmailService,
    private readonly sesEmailService: SesEmailService,
  ) {}

  @Post("send")
  async sendOtp(@Body() body: any) {
    const { type, value } = body;
    if (!type || !value) {
      return { error: "Missing type or value" };
    }
    // Generate cryptographically secure 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    // Store with 5-minute expiry
    otpStore.set(`${type}:${value}`, { otp, expires: Date.now() + 5 * 60 * 1000 });
    if (type === "email") {
      const subject = "Your TrendStarz OTP";
      const text = `Your OTP is: ${otp}. It expires in 5 minutes.`;
      // Use SES in production, Nodemailer in dev
      if (process.env.NODE_ENV === "production") {
        await this.sesEmailService.sendMail(value, subject, text);
      } else {
        await this.devEmailService.sendMail(value, subject, text);
      }
    }
    // Add phone logic if needed
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Post("verify")
  async verifyOtp(@Body() body: any) {
    const { type, value, otp } = body;
    if (!type || !value || !otp) {
      return { error: "Missing type, value, or otp" };
    }
    const key = `${type}:${value}`;
    const stored = otpStore.get(key);
    if (!stored) {
      return { error: "No OTP found. Please request a new one." };
    }
    if (Date.now() > stored.expires) {
      otpStore.delete(key);
      return { error: "OTP has expired. Please request a new one." };
    }
    if (stored.otp !== otp) {
      return { error: "Invalid OTP" };
    }
    // OTP is valid — consume it
    otpStore.delete(key);
    return { message: "OTP verified successfully" };
  }
}
