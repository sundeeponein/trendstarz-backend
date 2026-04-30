import { Schema, Types, model } from "mongoose";

export const USER_TYPES = ["INFLUENCER", "BRAND"] as const;
export const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;

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

// ── Offer (cross-plan discount / trial) ────────────────────────────────────
const PlanOfferSchema = new Schema(
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
    code: { type: String, required: true, unique: true },
    userType: {
      type: String,
      enum: USER_TYPES,
      required: true,
      index: true,
    },
    price: {
      monthly: { type: Number, default: 0 },
      quarterly: { type: Number, default: 0 },
      yearly: { type: Number, default: 0 },
    },
    features: { type: [PlanFeatureSchema], default: [] },
    limits: { type: [PlanLimitSchema], default: [] },
    offers: { type: [PlanOfferSchema], default: [] },
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
      enum: USER_TYPES,
      required: true,
    },
    planId: {
      type: Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    billingCycle: {
      type: String,
      enum: BILLING_CYCLES,
      required: true,
    },
    priceSnapshot: { type: Number, required: true },
    featuresSnapshot: { type: [PlanFeatureSchema], default: [] },
    limitsSnapshot: { type: [PlanLimitSchema], default: [] },
    policiesSnapshot: {
      imageRetentionDaysAfterExpiry: { type: Number, default: 45 },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    status: {
      type: String,
      enum: ["active", "expired", "cancelled"],
      default: "active",
      index: true,
    },
    imagesMarkedForDeletionAt: { type: Date, default: null },
    source: { type: String, enum: ["admin", "payment"], default: "payment" },
  },
  { timestamps: true },
);
SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ endDate: 1, status: 1 });

export const SubscriptionModel = model("Subscription", SubscriptionSchema);

export const FREE_PLAN_DEFAULTS = {
  INFLUENCER: {
    features: [
      {
        key: "publicProfileListing",
        label: "Public profile listing",
        value: true,
      },
      {
        key: "socialMediaVisibility",
        label: "Show social media links",
        value: true,
      },
      {
        key: "contactVisibility",
        label: "Contact details visible to brands",
        value: false,
      },
      {
        key: "priorityListing",
        label: "Priority search ranking",
        value: false,
      },
      {
        key: "analyticsDashboard",
        label: "Analytics dashboard",
        value: false,
      },
      {
        key: "canWriteReview",
        label: "Write reviews for brands",
        value: false,
      },
      {
        key: "canReadReviews",
        label: "View influencer & brand reviews",
        value: false,
      },
    ],
    limits: [
      { key: "maxProductImages", label: "Product images", value: 3 },
      { key: "maxActiveCampaigns", label: "Active campaign", value: 1 },
      { key: "maxInvitesPerCampaign", label: "Invites / campaign", value: 2 },
      { key: "maxInviteOptions", label: "Invite options", value: 5 },
    ],
    policies: { imageRetentionDaysAfterExpiry: 45 },
  },
  BRAND: {
    features: [
      {
        key: "browseInfluencerProfiles",
        label: "Browse influencer profiles",
        value: true,
      },
      {
        key: "viewSocialLinks",
        label: "View public social links",
        value: true,
      },
      {
        key: "viewContactDetails",
        label: "View contact details",
        value: true,
      },
      {
        key: "advancedSearchFilters",
        label: "Advanced search & filters",
        value: false,
      },
      {
        key: "campaignAnalyticsDashboard",
        label: "Campaign analytics dashboard",
        value: false,
      },
      {
        key: "bulkOutreachTools",
        label: "Bulk outreach tools",
        value: false,
      },
      {
        key: "canWriteReview",
        label: "Write reviews for influencers",
        value: false,
      },
      {
        key: "canReadReviews",
        label: "View influencer & brand reviews",
        value: false,
      },
    ],
    limits: [
      { key: "maxActiveCampaigns", label: "Active campaign", value: 1 },
      { key: "maxInvitesPerCampaign", label: "Invites / campaign", value: 1 },
      { key: "maxTeamSeats", label: "Team seats", value: 1 },
      { key: "analytics", label: "Analytics", value: 0 },
    ],
    policies: { imageRetentionDaysAfterExpiry: 45 },
  },
};
