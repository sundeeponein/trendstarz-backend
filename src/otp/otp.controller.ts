import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { randomInt, randomBytes, createHash, timingSafeEqual } from "crypto";
import { otpTemplate } from "../email/templates/otp.templates";
import { sendAppEmail } from "../utils/app-email.service";
import type { SmsProvider } from "../services/smsProvider.service";

/**
 * OTP record stored in-memory.
 * - `hash`/`salt`: sha256(salt + otp) — we never persist the plaintext OTP.
 * - `attempts`: failed verification attempts; locks out after MAX_ATTEMPTS.
 * - `sendHistory`: timestamps of recent sends used for per-value rate-limiting.
 */
interface OtpRecord {
  hash: string;
  salt: string;
  expires: number;
  attempts: number;
  sendHistory: number[];
}

const otpStore = new Map<string, OtpRecord>();
const OTP_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const SEND_MIN_INTERVAL_MS = 30 * 1000; // 30s between sends per value
const SEND_HOURLY_LIMIT = 5; // max sends per value per rolling hour
const SEND_WINDOW_MS = 60 * 60 * 1000;

function hashOtp(otp: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${otp}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

@Controller("otp")
export class OtpController {
  constructor(
    @Inject("SMS_PROVIDER") private readonly smsProvider: SmsProvider,
  ) {}

  @Post("send")
  async sendOtp(@Body() body: any) {
    const { type, value } = body || {};
    if (!type || !value) {
      return { error: "Missing type or value" };
    }
    const key = String(value).trim().toLowerCase();

    // Pull existing record to enforce send rate limits and preserve send history.
    const now = Date.now();
    const existing = otpStore.get(key);
    const history = (existing?.sendHistory || []).filter(
      (t) => now - t < SEND_WINDOW_MS,
    );
    if (history.length && now - history[history.length - 1] < SEND_MIN_INTERVAL_MS) {
      throw new HttpException(
        { error: "Please wait a moment before requesting another OTP." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (history.length >= SEND_HOURLY_LIMIT) {
      throw new HttpException(
        { error: "Too many OTP requests. Please try again later." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = randomInt(100000, 1000000).toString();
    const salt = randomBytes(16).toString("hex");
    const hash = hashOtp(otp, salt);
    history.push(now);
    otpStore.set(key, {
      hash,
      salt,
      expires: now + OTP_TTL,
      attempts: 0,
      sendHistory: history,
    });
    if (type === "email") {
      const template = otpTemplate({ otp, expiryMinutes: OTP_TTL / 60 / 1000 });
      await sendAppEmail({
        to: value,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });
    } else if (type === "phone") {
      await this.smsProvider.send(
        value,
        `Your TrendStarz OTP is ${otp}. It expires in ${OTP_TTL / 60 / 1000} minutes.`,
      );
    }
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Post("verify")
  verifyOtp(@Body() body: any) {
    const { type, value, otp } = body || {};
    if (!type || !value || !otp) {
      return { error: "Missing type, value, or otp" };
    }
    const key = String(value).trim().toLowerCase();
    const stored = otpStore.get(key);
    if (!stored) {
      return { error: "Invalid or expired OTP" };
    }
    if (Date.now() > stored.expires) {
      otpStore.delete(key);
      return { error: "Invalid or expired OTP" };
    }
    if (stored.attempts >= MAX_VERIFY_ATTEMPTS) {
      otpStore.delete(key);
      throw new HttpException(
        { error: "Too many incorrect attempts. Please request a new OTP." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const candidate = hashOtp(String(otp), stored.salt);
    if (!safeEqualHex(candidate, stored.hash)) {
      stored.attempts += 1;
      const remaining = MAX_VERIFY_ATTEMPTS - stored.attempts;
      if (remaining <= 0) {
        otpStore.delete(key);
        throw new HttpException(
          { error: "Too many incorrect attempts. Please request a new OTP." },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return { error: "Invalid or expired OTP" };
    }
    otpStore.delete(key);
    return { message: "OTP verified successfully" };
  }
}
