import { Controller, Post, Body } from "@nestjs/common";
import { randomInt } from "crypto";
import { DevEmailService } from "../utils/dev-email.service";
import { SesEmailService } from "../utils/ses-email.service";

const otpStore = new Map<string, { otp: string; expires: number }>();
const OTP_TTL = 5 * 60 * 1000; // 5 minutes

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
    const otp = randomInt(100000, 999999).toString();
    otpStore.set(value, { otp, expires: Date.now() + OTP_TTL });
    if (type === "email") {
      const subject = "Your TrendStarz OTP";
      const text = `Your OTP is: ${otp}`;
      if (process.env.NODE_ENV === "production") {
        await this.sesEmailService.sendMail(value, subject, text);
      } else {
        await this.devEmailService.sendMail(value, subject, text);
      }
    }
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Post("verify")
  verifyOtp(@Body() body: any) {
    const { type, value, otp } = body;
    if (!type || !value || !otp) {
      return { error: "Missing type, value, or otp" };
    }
    const stored = otpStore.get(value);
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
      return { error: "Invalid or expired OTP" };
    }
    otpStore.delete(value);
    return { message: "OTP verified successfully" };
  }
}
