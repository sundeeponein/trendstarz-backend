import { Schema, Document } from "mongoose";

export const CampaignTransactionSchema = new Schema(
  {
    transactionType: {
      type: String,
      enum: ["paid_collab", "pay_to_join", "platform_fee"],
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
    // Type locked 2026-10-17 to what every stored row already holds (cron/auditIdTypes.js).
    // campaignId/payerId/recipientId are 24-hex strings; inviteId is an ObjectId.
    campaignId: {
      type: String,
      ref: "Campaign",
      required: true,
      index: true,
    },
    inviteId: {
      type: Schema.Types.ObjectId,
      ref: "CampaignInvite",
      required: true,
      index: true,
    },
    // platform_fee rows: the invite the fee confirms. Their inviteId is a placeholder
    // id (never the real invite), so payout/refund/dispute code that looks transactions
    // up by inviteId can never pick up a fee.
    feeInviteId: { type: Schema.Types.ObjectId, default: null, index: true },
    // Fee refunded to the host as TrendStarZ credit (creator no-show, admin-approved).
    feeCreditedAt: { type: Date, default: null },
    // platform_fee rows: GST charged on this row's fee (paise), included in payerTotal.
    gstAmount: { type: Number, min: 0, default: 0 },
    // Razorpay: every order created for this row (a retry replaces paymentBatchId, so an
    // earlier order that still gets paid can be matched), and the order's amount (paise).
    gatewayOrderIds: { type: [String], default: undefined },
    gatewayOrderAmount: { type: Number, min: 0, default: null },
    payerId: { type: String, required: true, index: true },
    payerRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
    },
    recipientId: { type: String, required: true, index: true },
    recipientRole: {
      type: String,
      enum: ["influencer", "brand", "photographer"],
      required: true,
    },
    agreedAmount: { type: Number, min: 0, required: true },
    platformFee: { type: Number, min: 0, required: true },
    payerTotal: { type: Number, min: 0, required: true },
    recipientFee: { type: Number, min: 0, default: 0 },
    // GST on the creator payout fee (paise), deducted from the payout. 0 while off.
    recipientFeeGst: { type: Number, default: 0, min: 0 },
    recipientPayout: { type: Number, min: 0, required: true },

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
    disputedBy: { type: String }, // userId of whoever raised dispute
    disputedByRole: { type: String }, // 'brand' | 'influencer' | 'photographer' | 'admin'
    disputedAt: { type: Date },
    resolveOutcome: {
      type: String,
      enum: ["release_to_influencer", "refund_to_brand"],
    },
    resolvedBy: { type: String }, // admin userId
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
    refundOwedBy: { type: String },
    refundOwedReason: { type: String },
    refundCancelledAt: { type: Date },
    refundAmount: { type: Number, min: 0 }, // paise actually sent back
    refundUtr: { type: String },
    refundTransferDate: { type: Date }, // when the UPI transfer was made (admin-entered)
    refundSentAt: { type: Date }, // when admin recorded it
    refundSentBy: { type: String }, // admin userId
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
      reviewedBy: { type: String },
      reviewNote: { type: String },
    },

    // Refund policy fixed at payment time: "full_refund" (before terms v2) or "fee_credit"
    // (terms v2: creator amount back by UPI, platform fee back as TrendStarZ credit).
    refundPolicy: { type: String, enum: ["full_refund", "fee_credit"] },
    creditApplied: { type: Number, min: 0, default: 0 }, // paise of credit that paid this fee
    feeCredit: {
      status: {
        type: String,
        enum: ["needs_review", "issued", "withheld", "reversed"],
      },
      amount: { type: Number, min: 0 },
      issuedAt: { type: Date },
      ledgerEntryId: { type: String },
      reviewedBy: { type: String },
      reviewedAt: { type: Date },
      note: { type: String },
    },
    // Set when the system closed the creator for not posting (completion record).
    noPostClosure: { type: Boolean },
    // Admin-approved cancellation after work started: part of the money goes to the creator.
    compensation: {
      amount: { type: Number, min: 0 }, // paise paid to the creator
      decidedBy: { type: String },
      decidedAt: { type: Date },
      note: { type: String },
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
      amount: { type: Number, min: 0 }, // paise the host is asked to repay
      reason: { type: String },
      openedAt: { type: Date },
      openedBy: { type: String },
      hostRepaymentUtr: { type: String },
      hostRepaidAmount: { type: Number, min: 0 },
      hostRepaidAt: { type: Date },
      closedAt: { type: Date },
      closedBy: { type: String },
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
  refundPolicy?: "full_refund" | "fee_credit";
  creditApplied?: number;
  feeCredit?: {
    status?: "needs_review" | "issued" | "withheld" | "reversed";
    amount?: number;
    issuedAt?: Date;
    ledgerEntryId?: string;
    reviewedBy?: string;
    reviewedAt?: Date;
    note?: string;
  };
  noPostClosure?: boolean;
  compensation?: {
    amount?: number;
    decidedBy?: string;
    decidedAt?: Date;
    note?: string;
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
