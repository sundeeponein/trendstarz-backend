import { Schema } from "mongoose";

/**
 * TrendStarZ credit ledger (host fee credit). Append-only entries:
 *   issued    a credit lot (amount, remaining, expiresAt) — e.g. the platform fee returned
 *             on a genuine no-post refund under terms v2
 *   used      credit applied to a new platform fee (references the lot it came from)
 *   restored  a use given back (the payment it paid for was rejected)
 *   expired   unused credit removed when the lot expired (12 months)
 *   reversed  credit taken back (settlement: the post was verified after the refund)
 * Only `remaining` on issued lots changes; every movement is its own entry.
 * Credit can only pay future TrendStarZ platform fees — never creator payments.
 */
export const PlatformCreditSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    ownerRole: { type: String, enum: ["brand", "influencer", "photographer"] },
    type: {
      type: String,
      enum: ["issued", "used", "restored", "expired", "reversed"],
      required: true,
      index: true,
    },
    amount: { type: Number, min: 0, required: true }, // paise, always positive
    remaining: { type: Number, min: 0 }, // issued lots only
    expiresAt: { type: Date, index: true }, // issued lots only
    lotId: { type: Schema.Types.ObjectId }, // used / restored / expired / reversed
    transactionId: { type: String, index: true },
    campaignId: { type: String },
    reason: { type: String },
    createdBy: { type: String },
    restoredAt: { type: Date }, // on a "used" entry once given back
  },
  { timestamps: true },
);
PlatformCreditSchema.index({ ownerId: 1, type: 1, expiresAt: 1 });
