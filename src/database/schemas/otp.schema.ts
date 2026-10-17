import { Schema } from "mongoose";

/**
 * One pending OTP per email/phone (collection: otp_codes). Only a salted hash
 * of the code is stored. Kept in MongoDB, not process memory, so codes,
 * attempt counts and send rate limits survive deploys/restarts and are shared
 * by every server instance. `purgeAt` (TTL) removes the row once neither the
 * code nor its send history (used for the hourly rate limit) matters any more.
 */
export const OtpCodeSchema = new Schema(
  {
    key: { type: String, required: true }, // normalized email/phone
    // Cleared once the code is used, expires or is locked out.
    hash: { type: String },
    salt: { type: String },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    sendHistory: { type: [Date], default: [] },
    purgeAt: { type: Date, required: true },
  },
  { collection: "otp_codes", timestamps: true },
);
OtpCodeSchema.index({ key: 1 }, { unique: true });
OtpCodeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Proof that an OTP was verified, handed to the browser and redeemed once by
 * signup/profile flows (collection: otp_verification_tokens). Stored as a
 * sha256 of the token; removed when redeemed or by TTL at `expiresAt`.
 */
export const OtpVerificationTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    type: { type: String, required: true }, // "phone" | "email"
    value: { type: String, required: true }, // normalized email/phone
    expiresAt: { type: Date, required: true },
  },
  { collection: "otp_verification_tokens", timestamps: true },
);
OtpVerificationTokenSchema.index({ tokenHash: 1 }, { unique: true });
OtpVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
