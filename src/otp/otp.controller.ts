import { Controller, Post, Body } from "@nestjs/common";
import { DevEmailService } from "../utils/dev-email.service";
import { SesEmailService } from "../utils/ses-email.service";

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
    // Generate OTP (for demo, use 123456)
    const otp = "123456";
    if (type === "email") {
      const subject = "Your TrendStarz OTP";
      const text = `Your OTP is: ${otp}`;
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
    // Simulate OTP verification
    // In real app, check OTP from DB
    if (otp === "123456") {
      return { message: "OTP verified successfully" };
    }
    return { error: "Invalid OTP" };
  }
}
