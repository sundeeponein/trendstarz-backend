import { Schema, Types, model } from "mongoose";

// ── Feature toggle (boolean) ────────────────────────────────────────────────
const PlanFeatureSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    value: { type: Boolean, default: true },
  },
  { _id: false },
);

// ── Numeric limit ───────────────────────────────────────────────────────────
const PlanLimitSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    value: { type: Number, default: 0 },
  },
  { _id: false },
);

// ── Plan ────────────────────────────────────────────────────────────────────
export const PlanSchema = new Schema(
  {
    name: { type: String, required: true },
    userType: {
      type: String,
      enum: ["INFLUENCER", "BRAND", "ALL"],
      required: true,
    },
    price: {
      monthly: { type: Number, default: 0 },
      yearly: { type: Number, default: 0 },
    },
    features: { type: [PlanFeatureSchema], default: [] },
    limits: { type: [PlanLimitSchema], default: [] },
    policies: {
      imageRetentionDaysAfterExpiry: { type: Number, default: 45 },
    },
    highlight: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const PlanModel = model("Plan", PlanSchema);

// ── Subscription ─────────────────────────────────────────────────────────────
export const SubscriptionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, required: true, index: true },
    userType: {
      type: String,
      enum: ["Influencer", "Brand"],
      required: true,
    },
    planId: {
      type: Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    planName: { type: String },
    // snapshot of plan features at time of subscription
    featuresSnapshot: { type: [PlanFeatureSchema], default: [] },
    limitsSnapshot: { type: [PlanLimitSchema], default: [] },
    policiesSnapshot: {
      imageRetentionDaysAfterExpiry: { type: Number, default: 45 },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    duration: { type: String, enum: ["1m", "3m", "1y"] },
    status: {
      type: String,
      enum: ["active", "expired", "cancelled"],
      default: "active",
    },
    // set when images are scheduled for cleanup after expiry
    imagesMarkedForDeletionAt: { type: Date, default: null },
  },
  { timestamps: true },
);
SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ endDate: 1, status: 1 });

export const SubscriptionModel = model("Subscription", SubscriptionSchema);

// Default free-tier limits used when user has no active subscription
export const FREE_PLAN_DEFAULTS = {
  features: [
    {
      key: "socialMediaVisibility",
      label: "Show Social Media Links",
      value: false,
    },
    {
      key: "contactVisibility",
      label: "Show Contact Details",
      value: false,
    },
    {
      key: "priorityListing",
      label: "Priority Listing in Search",
      value: false,
    },
  ],
  limits: [
    { key: "maxImages", label: "Max Images Upload", value: 2 },
    { key: "maxCampaigns", label: "Max Campaigns", value: 1 },
  ],
  policies: { imageRetentionDaysAfterExpiry: 45 },
};
