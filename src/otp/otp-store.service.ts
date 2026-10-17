import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

export const OTP_TTL_MS = 5 * 60 * 1000; // code valid 5 minutes
export const VERIFIED_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish signup
export const MAX_VERIFY_ATTEMPTS = 5;
export const SEND_MIN_INTERVAL_MS = 30 * 1000; // 30s between sends per value
export const SEND_HOURLY_LIMIT = 5; // max sends per value per rolling hour
const SEND_WINDOW_MS = 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqualHex(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function normalizeOtpKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export type VerifyResult =
  | { ok: true; verificationToken: string }
  | { ok: false; error: string };

/**
 * OTP codes and verification tokens, persisted in MongoDB (see otp.schema.ts)
 * so they survive restarts and work across server instances.
 */
@Injectable()
export class OtpStoreService {
  constructor(
    @InjectModel("OtpCode") private readonly codeModel: Model<any>,
    @InjectModel("OtpVerificationToken")
    private readonly tokenModel: Model<any>,
  ) {}

  /** Creates a new code for `value` (rate-limited); returns the plaintext code to send. */
  async issueCode(value: unknown, now = new Date()): Promise<string> {
    const key = normalizeOtpKey(value);
    const existing: any = await this.codeModel.findOne({ key }).lean();
    const history: Date[] = (existing?.sendHistory || []).filter(
      (t: Date) => now.getTime() - new Date(t).getTime() < SEND_WINDOW_MS,
    );
    const last = history[history.length - 1];
    if (last && now.getTime() - new Date(last).getTime() < SEND_MIN_INTERVAL_MS) {
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
    await this.codeModel.updateOne(
      { key },
      {
        $set: {
          key,
          hash: sha256(`${salt}:${otp}`),
          salt,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
          attempts: 0,
          sendHistory: [...history, now],
          // Keep the row while the hourly send limit still needs its history.
          purgeAt: new Date(now.getTime() + SEND_WINDOW_MS),
        },
      },
      { upsert: true },
    );
    return otp;
  }

  /**
   * Checks a code. On success the code is consumed (atomically — a code can
   * be used once even with simultaneous requests) and a one-time
   * verification token is returned.
   */
  async verifyCode(
    type: unknown,
    value: unknown,
    otp: unknown,
    now = new Date(),
  ): Promise<VerifyResult> {
    const key = normalizeOtpKey(value);
    const invalid: VerifyResult = { ok: false, error: "Invalid or expired OTP" };
    const stored: any = await this.codeModel.findOne({ key }).lean();
    if (!stored || !stored.hash) return invalid;
    if (now > new Date(stored.expiresAt)) {
      await this.clearCode(stored);
      return invalid;
    }
    if (Number(stored.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
      await this.clearCode(stored);
      throw new HttpException(
        { error: "Too many incorrect attempts. Please request a new OTP." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const candidate = sha256(`${stored.salt}:${String(otp)}`);
    if (!safeEqualHex(candidate, stored.hash)) {
      const updated: any = await this.codeModel
        .findOneAndUpdate(
          { _id: stored._id, hash: stored.hash },
          { $inc: { attempts: 1 } },
          { new: true },
        )
        .lean();
      if (Number(updated?.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
        await this.clearCode(stored);
        throw new HttpException(
          { error: "Too many incorrect attempts. Please request a new OTP." },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return invalid;
    }
    // Consume: only one request can turn this code into a token.
    const consumed = await this.codeModel.updateOne(
      { _id: stored._id, hash: stored.hash },
      { $unset: { hash: "", salt: "" }, $set: { expiresAt: now } },
    );
    if (!consumed.modifiedCount) return invalid;
    const verificationToken = randomBytes(24).toString("hex");
    await this.tokenModel.create({
      tokenHash: sha256(verificationToken),
      type: normalizeOtpKey(type),
      value: key,
      expiresAt: new Date(now.getTime() + VERIFIED_OTP_TTL_MS),
    });
    return { ok: true, verificationToken };
  }

  /**
   * Redeems a verification token for `type`/`value`. One use only: the token
   * is deleted whether or not it matches (same as before).
   */
  async consumeVerificationToken(
    type: unknown,
    value: unknown,
    token?: unknown,
    now = new Date(),
  ): Promise<boolean> {
    if (!token || typeof token !== "string") return false;
    const record: any = await this.tokenModel
      .findOneAndDelete({ tokenHash: sha256(token) })
      .lean();
    if (!record || now > new Date(record.expiresAt)) return false;
    return (
      record.type === normalizeOtpKey(type) &&
      record.value === normalizeOtpKey(value)
    );
  }

  /** Ends the current code but keeps the send history for rate limiting. */
  private async clearCode(stored: any) {
    await this.codeModel.updateOne(
      { _id: stored._id },
      { $unset: { hash: "", salt: "" }, $set: { expiresAt: new Date(0) } },
    );
  }
}
