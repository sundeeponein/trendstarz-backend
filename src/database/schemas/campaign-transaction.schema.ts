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
      enum: [
        "brand_to_influencer",
        "brand_to_photographer",
        "photographer_to_influencer",
        "photographer_to_photographer",
        "influencer_to_brand",
        "photographer_to_brand",
        "influencer_to_photographer",
        "influencer_to_influencer",
      ],
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
    payerRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
    },
    recipientId: { type: Schema.Types.Mixed, required: true, index: true },
    recipientRole: {
      type: String,
      enum: ["influencer", "brand", "photographer"],
      required: true,
    },
    agreedAmount: { type: Number, required: true },
    platformFee: { type: Number, required: true },
    payerTotal: { type: Number, required: true },
    recipientFee: { type: Number, default: 0 },
    recipientPayout: { type: Number, required: true },

    // ── Payment gateway (swap field value to switch provider; no schema change needed) ──
    // MVP: manual_upi. Future: razorpay (auto-capture + escrow).
    gateway: {
      type: String,
      enum: ["manual_upi", "razorpay"],
      default: "manual_upi",
      index: true,
    },

    // ── Brand collection (Phase 2: brand pays via UPI / QR) ──────────────────
    paymentBatchId: { type: String, index: true },
    gatewayOrderId: { type: String, index: true },
    gatewayPaymentId: { type: String, index: true },
    gatewaySignature: { type: String },
    gatewayVerifiedAt: { type: Date },
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
    payoutGatewayProvider: {
      type: String,
      enum: ["manual_upi", "razorpayx"],
      default: "manual_upi",
      index: true,
    },
    payoutTransferId: { type: String, index: true },
    payoutTransferStatus: { type: String, index: true },
    payoutFailureReason: { type: String },
    payoutRetryCount: { type: Number, default: 0 },
    payoutLastRetryAt: { type: Date },
    payoutInitiatedAt: { type: Date },
    payoutSettledAt: { type: Date },
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
    disputeIssueReason: { type: String },
    disputeReason: { type: String },
    disputeEvidenceUrl: { type: String },
    disputedBy: { type: Schema.Types.Mixed }, // userId of whoever raised dispute
    disputedByRole: { type: String }, // 'brand' | 'influencer' | 'photographer' | 'admin'
    disputedAt: { type: Date },
    resolveOutcome: {
      type: String,
      enum: ["release_to_influencer", "refund_to_brand"],
    },
    resolvedBy: { type: Schema.Types.Mixed }, // admin userId
    resolvedAt: { type: Date },

    // ── Refund to payer (manual UPI; see payments-payouts/campaign-refund.util.ts) ──
    // on_hold → owed → sent (or cancelled when a late post is verified first).
    refundStatus: {
      type: String,
      enum: ["none", "on_hold", "owed", "sent", "cancelled"],
      default: "none",
      index: true,
    },
    refundOnHoldAt: { type: Date },
    refundHoldUntil: { type: Date, index: true },
    refundOwedAt: { type: Date },
    refundOwedBy: { type: Schema.Types.Mixed },
    refundOwedReason: { type: String },
    refundCancelledAt: { type: Date },
    refundAmount: { type: Number }, // paise actually sent back
    refundUtr: { type: String },
    refundTransferDate: { type: Date }, // when the UPI transfer was made (admin-entered)
    refundSentAt: { type: Date }, // when admin recorded it
    refundSentBy: { type: Schema.Types.Mixed }, // admin userId
    refundNote: { type: String },
    // Append-only audit trail of every refund / late-post / settlement decision.
    refundHistory: { type: [Schema.Types.Mixed], default: undefined },

    // Post link the creator submitted after the deadline, during the refund hold.
    latePost: {
      url: { type: String },
      note: { type: String },
      submittedAt: { type: Date },
      originalDeadline: { type: Date },
      status: { type: String, enum: ["pending", "approved", "rejected"] },
      reviewedAt: { type: Date },
      reviewedBy: { type: Schema.Types.Mixed },
      reviewNote: { type: String },
    },

    // Delivery verified after the refund was already sent: host repays, then creator is paid.
    settlement: {
      status: {
        type: String,
        enum: [
          "none",
          "awaiting_host_repayment",
          "repaid",
          "exception_approved",
        ],
      },
      amount: { type: Number }, // paise the host is asked to repay
      reason: { type: String },
      openedAt: { type: Date },
      openedBy: { type: Schema.Types.Mixed },
      hostRepaymentUtr: { type: String },
      hostRepaidAmount: { type: Number },
      hostRepaidAt: { type: Date },
      closedAt: { type: Date },
      closedBy: { type: Schema.Types.Mixed },
      exceptionReason: { type: String },
    },

    adminNotes: { type: String },
  },
  { timestamps: true },
);

CampaignTransactionSchema.index(
  { campaignId: 1, inviteId: 1, payerId: 1 },
  { unique: true },
);
// Admin dispute queue
CampaignTransactionSchema.index({ disputeStatus: 1, createdAt: -1 });

export interface CampaignTransaction extends Document {
  campaignId: string;
  inviteId: string;
  payerId: string;
  payerRole: "brand" | "influencer" | "photographer";
  recipientId: string;
  recipientRole: "influencer" | "brand" | "photographer";
  agreedAmount: number;
  platformFee: number;
  payerTotal: number;
  recipientFee: number;
  recipientPayout: number;
  gateway: "manual_upi" | "razorpay";
  paymentBatchId?: string;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  gatewaySignature?: string;
  gatewayVerifiedAt?: Date;
  payoutGatewayProvider?: "manual_upi" | "razorpayx";
  payoutTransferId?: string;
  payoutTransferStatus?: string;
  payoutFailureReason?: string;
  payoutRetryCount?: number;
  payoutLastRetryAt?: Date;
  payoutInitiatedAt?: Date;
  payoutSettledAt?: Date;
  collectionStatus:
    | "awaiting_payment"
    | "proof_submitted"
    | "verified"
    | "failed";
  payoutStatus: "pending" | "processing" | "paid" | "skipped" | "frozen";
  workStatus: "pending" | "submitted" | "approved" | "disputed";
  disputeStatus: "none" | "open" | "resolved";
  disputeIssueReason?: string;
  disputeReason?: string;
  disputeEvidenceUrl?: string;
  disputedBy?: string;
  disputedByRole?: string;
  disputedAt?: Date;
  resolveOutcome?: "release_to_influencer" | "refund_to_brand";
  resolvedBy?: string;
  resolvedAt?: Date;
  refundStatus?: "none" | "on_hold" | "owed" | "sent" | "cancelled";
  refundOnHoldAt?: Date;
  refundHoldUntil?: Date;
  refundOwedAt?: Date;
  refundOwedBy?: string;
  refundOwedReason?: string;
  refundCancelledAt?: Date;
  refundAmount?: number;
  refundUtr?: string;
  refundTransferDate?: Date;
  refundSentAt?: Date;
  refundSentBy?: string;
  refundNote?: string;
  refundHistory?: Array<Record<string, any>>;
  latePost?: {
    url?: string;
    note?: string;
    submittedAt?: Date;
    originalDeadline?: Date;
    status?: "pending" | "approved" | "rejected";
    reviewedAt?: Date;
    reviewedBy?: string;
    reviewNote?: string;
  };
  settlement?: {
    status?:
      | "none"
      | "awaiting_host_repayment"
      | "repaid"
      | "exception_approved";
    amount?: number;
    reason?: string;
    openedAt?: Date;
    openedBy?: string;
    hostRepaymentUtr?: string;
    hostRepaidAmount?: number;
    hostRepaidAt?: Date;
    closedAt?: Date;
    closedBy?: string;
    exceptionReason?: string;
  };
  adminNotes?: string;
}
