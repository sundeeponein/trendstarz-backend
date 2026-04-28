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
    utrNumber: { type: String },
    paymentProofUrl: { type: String },
    collectionStatus: {
      type: String,
      enum: ["awaiting_payment", "proof_submitted", "verified", "failed"],
      default: "awaiting_payment",
      index: true,
    },
    collectedAt: { type: Date },
    payoutUpiId: { type: String },
    payoutUtr: { type: String },
    payoutProofUrl: { type: String },
    payoutStatus: {
      type: String,
      enum: ["pending", "processing", "paid", "skipped"],
      default: "pending",
      index: true,
    },
    paidOutAt: { type: Date },
    workStatus: {
      type: String,
      enum: ["pending", "submitted", "approved", "disputed"],
      default: "pending",
      index: true,
    },
    adminNotes: { type: String },
  },
  { timestamps: true },
);

CampaignTransactionSchema.index({ campaignId: 1, inviteId: 1, payerId: 1 }, { unique: true });

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
  collectionStatus: "awaiting_payment" | "proof_submitted" | "verified" | "failed";
  payoutStatus: "pending" | "processing" | "paid" | "skipped";
  workStatus: "pending" | "submitted" | "approved" | "disputed";
}
