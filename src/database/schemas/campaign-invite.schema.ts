import { Schema } from "mongoose";

export const CampaignInviteSchema = new Schema({
  campaignId: { type: Schema.Types.Mixed, ref: "Campaign", required: true },
  influencerId: {
    type: Schema.Types.ObjectId,
    ref: "Influencer",
    required: true,
  },
  brandId: { type: Schema.Types.Mixed, ref: "Brand", required: true }, // Allow ObjectId or string
  status: {
    type: String,
    enum: [
      "pending",
      "invited",
      "counter_sent",
      "accepted",
      "declined",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "disputed",
      "withdrawn",
    ],
    default: "pending",
  },
  analytics: {
    reach: Number,
    engagement: Number,
    clicks: Number,
  },
  selectedPostDate: { type: Date },
  // 24h after selectedPostDate — insights screenshot + metrics unlock after this
  insightsUnlocksAt: { type: Date },
  // Influencer's chosen content type when accepting
  selectedPlatform: { type: String },
  selectedContentType: { type: String },
  agreedAmount: { type: Number },
  // Canonical payout amount for payment calculations (paise).
  agreedAmountPaise: { type: Number },
  // Counter-offer requested by recipient during acceptance.
  counterOffer: {
    status: {
      type: String,
      enum: ["none", "sent", "brand_sent", "accepted", "declined"],
      default: "none",
    },
    pricingMode: {
      type: String,
      enum: ["flat", "deliverable_based"],
    },
    selectedPlatform: { type: String },
    selectedContentType: { type: String },
    offeredAmount: { type: Number },
    offeredAmountPaise: { type: Number },
    requestedAmount: { type: Number },
    requestedAmountPaise: { type: Number },
    message: { type: String },
    sentAt: { type: Date },
    resolvedAt: { type: Date },
    responderId: { type: String },
  },
  acceptedAt: { type: Date },
  // When the campaign owner/payment flow confirmed the collaboration and work could begin.
  paymentConfirmedAt: { type: Date },
  completedAt: { type: Date },
  paidOutAt: { type: Date },
  // Contact preference snapshot at acceptance time.
  // This keeps existing accepted invites stable even if profile preferences change later.
  acceptedContact: {
    whatsapp: { type: Boolean, default: false },
    email: { type: Boolean, default: false },
    call: { type: Boolean, default: false },
  },
  acceptedContactSnapshotAt: { type: Date },
  // ── Contact unlock (single-rule: brand pays/premium → both sides see contact) ──
  unlocked: { type: Boolean, default: false },
  unlockedAt: { type: Date },
  unlockType: {
    type: String,
    enum: ["premium", "paid_collab_payment", "free_unlock"],
  },
  // ── Fulfillment (per campaign type) ──
  // For `product` campaigns — brand ships sample/product to influencer
  productFulfillment: {
    status: {
      type: String,
      enum: ["pending", "shipped", "delivered", "returned"],
      default: "pending",
    },
    courier: { type: String },
    trackingId: { type: String },
    trackingUrl: { type: String },
    shippedAt: { type: Date },
    deliveredAt: { type: Date },
    note: { type: String },
  },
  // For `invite_location` campaigns — influencer visits a location
  locationVisit: {
    status: {
      type: String,
      enum: ["pending", "checked_in", "no_show", "cancelled"],
      default: "pending",
    },
    scheduledAt: { type: Date },
    checkedInAt: { type: Date },
    note: { type: String },
  },
  // Generic deadline (content due / visit due / shipping due)
  dueDate: { type: Date },
  // ── Brand-side actions ──
  remindedAt: { type: Date },
  remindersSent: { type: Number, default: 0 },
  // Automated "your post is due soon" nudges to the creator, keyed by selectedPostDate — set once each
  // milestone fires so the cron never re-sends it (independent of the brand-initiated remindedAt above).
  postingReminder48hSentAt: { type: Date },
  postingReminder24hSentAt: { type: Date },
  withdrawnAt: { type: Date },
  withdrawnReason: { type: String },
  // Admin correction: this creator may submit until at least this time (see submissionWindow).
  submissionDeadlineExtendedTo: { type: Date },
  // Admin corrections log (append-only, admin-only — hidden from every query unless
  // selected with "+adminCorrections"): restore / extend / submit-on-behalf / cancel.
  adminCorrections: {
    type: [
      {
        _id: false,
        action: { type: String },
        reason: { type: String },
        by: { type: String },
        at: { type: Date },
        details: { type: Schema.Types.Mixed },
      },
    ],
    select: false,
  },
  // Stage 3B-4: set when an admin sent this invite on the owner's behalf from
  // the campaign eligibility list (brandId is still the campaign owner).
  invitedByAdminId: { type: String },
  invitedByAdminAt: { type: Date },
  reportedIssue: {
    reason: { type: String },
    reportedAt: { type: Date },
    resolvedAt: { type: Date },
    // Set when the influencer contests the dispute itself; pauses the auto-cancel timer and flags it for admin.
    adminReviewRequestedAt: { type: Date },
    // "offplatform" = "Asked to skip posting / deal outside TrendStarZ" (either side).
    category: { type: String },
    reportedByRole: { type: String },
  },
  // Paid-collaboration terms each side accepted (version + time).
  termsAcceptance: {
    host: {
      acceptedAt: { type: Date },
      version: { type: String },
      userId: { type: String },
    },
    creator: {
      acceptedAt: { type: Date },
      version: { type: String },
      userId: { type: String },
    },
  },
  // Kept when admin approves a late post: the original deadline and closure stay on record.
  latePostApproval: {
    approvedAt: { type: Date },
    approvedBy: { type: String },
    postUrl: { type: String },
    note: { type: String },
    originalDeadline: { type: Date },
    withdrawnAt: { type: Date },
    withdrawnReason: { type: String },
  },
  // A refund hold, pending late post or settlement still needs both sides' contact.
  financialCaseOpen: { type: Boolean },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
