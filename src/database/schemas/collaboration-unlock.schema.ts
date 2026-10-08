import { Schema, Document } from "mongoose";

export const CollaborationUnlockSchema = new Schema(
  {
    inviteId: {
      type: Schema.Types.ObjectId,
      ref: "CampaignInvite",
      required: true,
      index: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    payerId: { type: Schema.Types.ObjectId, required: true, index: true },
    payerRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
    },
    recipientId: { type: Schema.Types.ObjectId, required: true, index: true },
    recipientRole: {
      type: String,
      enum: ["influencer", "photographer", "brand"],
      required: true,
    },
    collaborationType: {
      type: String,
      enum: [
        "paid_campaign",
        "product_collaboration",
        "event_invite",
        "reels_ugc_collaboration",
        "photoshoot_collaboration",
      ],
      required: true,
      index: true,
    },
    unlockKind: {
      type: String,
      enum: ["paid_campaign_payment", "coordination_unlock_fee"],
      required: true,
    },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", index: true },
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", index: true },
    amount: { type: Number, required: true },
    platformCommissionPercent: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["created", "authorized", "captured", "failed", "refunded"],
      default: "created",
    },
    refundStatus: {
      type: String,
      enum: ["none", "requested", "processed", "rejected"],
      default: "none",
    },
    unlockedAt: { type: Date },
  },
  { timestamps: true },
);

CollaborationUnlockSchema.index({ inviteId: 1, payerId: 1 }, { unique: true });

export interface CollaborationUnlock extends Document {
  inviteId: string;
  campaignId: string;
  payerId: string;
  payerRole: "brand" | "influencer" | "photographer";
  recipientId: string;
  recipientRole: "influencer" | "photographer" | "brand";
  collaborationType:
    | "paid_campaign"
    | "product_collaboration"
    | "event_invite"
    | "reels_ugc_collaboration"
    | "photoshoot_collaboration";
  unlockKind: "paid_campaign_payment" | "coordination_unlock_fee";
  paymentId?: string;
  transactionId?: string;
  amount: number;
  platformCommissionPercent: number;
  gstPercent: number;
  status: "pending" | "paid" | "failed" | "refunded";
  paymentStatus: "created" | "authorized" | "captured" | "failed" | "refunded";
  refundStatus: "none" | "requested" | "processed" | "rejected";
  unlockedAt?: Date;
}
