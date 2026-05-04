import { Schema, Document } from "mongoose";

export const CampaignTransactionSchema = new Schema(
  {
    transactionType: {
      type: String,
      enum: ["paid_collab", "pay_to_join"],
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ["brand_to_influencer", "influencer_to_brand"],
      required: true,
    },
    campaignId: {
      type: Schema.Types.Mixed,
      ref: "Campaign",
      required: true,
      index: true,
    },
    inviteId: {
      type: Schema.Types.Mixed,
      ref: "CampaignInvite",
      required: true,
      index: true,
    },
    payerId: { type: Schema.Types.Mixed, required: true, index: true },
    payerRole: { type: String, enum: ["brand", "influencer"], required: true },
    recipientId: { type: Schema.Types.Mixed, required: true, index: true },
    recipientRole: {
      type: String,
      enum: ["influencer", "brand"],
      required: true,
    },
    agreedAmount: { type: Number, required: true },
    platformFee: { type: Number, required: true },
    payerTotal: { type: Number, required: true },
    recipientPayout: { type: Number, required: true },

    // ── Payment gateway (swap field value to switch provider; no schema change needed) ──
    // MVP: manual_upi. Future: razorpay (auto-capture + escrow), stripe (international).
    gateway: {
      type: String,
      enum: ["manual_upi", "razorpay", "stripe"],
      default: "manual_upi",
      index: true,
    },

    // ── Brand collection (Phase 2: brand pays via UPI / QR) ──────────────────
    utrNumber: { type: String },
    paymentProofUrl: { type: String },
    collectionStatus: {
      type: String,
      enum: ["awaiting_payment", "proof_submitted", "verified", "failed"],
      default: "awaiting_payment",
      index: true,
    },
    collectedAt: { type: Date },

    // ── Payout to influencer (Phase 6: admin sends UPI manually) ─────────────
    payoutUpiId: { type: String },
    payoutUtr: { type: String },
    payoutProofUrl: { type: String },
    payoutStatus: {
      type: String,
      // frozen = payment confirmed but dispute raised; admin must resolve before releasing
      enum: ["pending", "processing", "paid", "skipped", "frozen"],
      default: "pending",
      index: true,
    },
    paidOutAt: { type: Date },

    // ── Work status (Phase 4–5: influencer works, brand reviews) ─────────────
    workStatus: {
      type: String,
      enum: ["pending", "submitted", "approved", "disputed"],
      default: "pending",
      index: true,
    },

    // ── Dispute tracking (Phase 7: payment freeze while admin reviews) ────────
    disputeStatus: {
      type: String,
      enum: ["none", "open", "resolved"],
      default: "none",
      index: true,
    },
    disputeReason: { type: String },
    disputedBy: { type: Schema.Types.Mixed },     // userId of whoever raised dispute
    disputedByRole: { type: String },              // 'brand' | 'influencer' | 'admin'
    disputedAt: { type: Date },
    resolveOutcome: {
      type: String,
      enum: ["release_to_influencer", "refund_to_brand"],
    },
    resolvedBy: { type: Schema.Types.Mixed },      // admin userId
    resolvedAt: { type: Date },

    adminNotes: { type: String },
  },
  { timestamps: true },
);

CampaignTransactionSchema.index({ campaignId: 1, inviteId: 1, payerId: 1 }, { unique: true });
// Admin dispute queue
CampaignTransactionSchema.index({ disputeStatus: 1, createdAt: -1 });

export interface CampaignTransaction extends Document {
  campaignId: string;
  inviteId: string;
  payerId: string;
  payerRole: "brand" | "influencer";
  recipientId: string;
  recipientRole: "influencer" | "brand";
  agreedAmount: number;
  platformFee: number;
  payerTotal: number;
  recipientPayout: number;
  gateway: "manual_upi" | "razorpay" | "stripe";
  collectionStatus: "awaiting_payment" | "proof_submitted" | "verified" | "failed";
  payoutStatus: "pending" | "processing" | "paid" | "skipped" | "frozen";
  workStatus: "pending" | "submitted" | "approved" | "disputed";
  disputeStatus: "none" | "open" | "resolved";
  disputeReason?: string;
  disputedBy?: string;
  disputedByRole?: string;
  disputedAt?: Date;
  resolveOutcome?: "release_to_influencer" | "refund_to_brand";
  resolvedBy?: string;
  resolvedAt?: Date;
  adminNotes?: string;
}

