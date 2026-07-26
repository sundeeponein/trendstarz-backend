import { Schema, Document } from "mongoose";

export const TransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userRole: {
      type: String,
      enum: ["brand", "influencer", "photographer", "admin"],
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "subscription_payment",
        "invite_unlock_payment",
        "campaign_payment",
        "collab_score_reanalysis_payment",
        "refund",
      ],
      required: true,
      index: true,
    },
    relatedId: { type: String, default: "" },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    commissionAmount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    paymentProvider: {
      type: String,
      enum: ["razorpay", "manual_upi", "unknown"],
      default: "unknown",
    },
    orderId: { type: String, index: true },
    paymentId: { type: String, index: true },
    paymentStatus: {
      type: String,
      enum: ["created", "authorized", "captured", "failed", "refunded"],
      default: "created",
      index: true,
    },
    refundStatus: {
      type: String,
      enum: ["none", "requested", "processed", "failed"],
      default: "none",
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    logs: {
      type: [
        {
          at: { type: Date, default: Date.now },
          event: { type: String, required: true },
          payload: { type: Schema.Types.Mixed, default: {} },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ type: 1, paymentStatus: 1, createdAt: -1 });

export interface Transaction extends Document {
  userId: string;
  userRole: "brand" | "influencer" | "photographer" | "admin";
  type:
    | "subscription_payment"
    | "invite_unlock_payment"
    | "campaign_payment"
    | "collab_score_reanalysis_payment"
    | "refund";
  relatedId?: string;
  amount: number;
  currency: string;
  commissionAmount: number;
  gstAmount: number;
  netAmount: number;
  paymentProvider: "razorpay" | "manual_upi" | "unknown";
  orderId?: string;
  paymentId?: string;
  paymentStatus: "created" | "authorized" | "captured" | "failed" | "refunded";
  refundStatus: "none" | "requested" | "processed" | "failed";
  metadata: Record<string, any>;
}
