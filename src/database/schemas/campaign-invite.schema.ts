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
      "accepted",
      "declined",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
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
  // Influencer's chosen content type when accepting
  selectedPlatform: { type: String },
  selectedContentType: { type: String },
  agreedAmount: { type: Number },
  acceptedAt: { type: Date },
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
  withdrawnAt: { type: Date },
  withdrawnReason: { type: String },
  reportedIssue: {
    reason: { type: String },
    reportedAt: { type: Date },
    resolvedAt: { type: Date },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
