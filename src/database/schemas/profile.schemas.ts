// AppSettings schema for admin toggles and global settings
export const AppSettingsSchema = new Schema({
  preApproveInfluencers: { type: Boolean, default: false },
  influencerRequireEmailVerified: { type: Boolean, default: false },
  influencerRequireMobileVerified: { type: Boolean, default: false },
  preApproveBrands: { type: Boolean, default: false },
  brandRequireEmailVerified: { type: Boolean, default: false },
  brandRequireMobileVerified: { type: Boolean, default: false },
  // Add more global settings here as needed
});
export const AppSettingsModel = model("AppSettings", AppSettingsSchema);
import { Schema, Types, model } from "mongoose";

export const TierSchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String },
  desc: { type: String },
  showInFrontend: { type: Boolean, default: true },
});
export const TierModel = model("Tier", TierSchema);

// Language schema
export const LanguageSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const LanguageModel = model("Language", LanguageSchema);

// User schema (for admin and future users)
export const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["admin", "user"], default: "user" },
  isEmailVerified: { type: Boolean, default: false },
  isMobileVerified: { type: Boolean, default: false },
});
export const UserModel = model("User", UserSchema);

// All schema definitions go here (LanguageSchema, UserSchema, etc.)
export const InfluencerSchema = new Schema(
  {
    password: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phoneNumber: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    profileImages: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // Cloudinary image objects
    isPremium: { type: Boolean, default: false },
    premiumDuration: {
      type: String,
      enum: ["1m", "3m", "1y", null],
      default: null,
    }, // 1 month, 3 months, 1 year
    premiumStart: { type: Date, default: null },
    premiumEnd: { type: Date, default: null },
    categories: [{ type: String }],
    languages: [{ type: String }],
    location: {
      state: { type: String },
    },
    socialMedia: [
      {
        platform: { type: String },
        handle: { type: String },
        tier: { type: String },
        followersCount: { type: Number },
      },
    ],
    contact: {
      whatsapp: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      call: { type: Boolean, default: false },
    },
    promotionalPrice: { type: Number },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "deleted"],
      default: "pending",
    },
  },
  { timestamps: true },
);
InfluencerSchema.index({ status: 1 });
InfluencerSchema.index({ categories: 1 });
InfluencerSchema.index({ "location.state": 1 });

export const InfluencerModel = model("Influencer", InfluencerSchema);

export const BrandSchema = new Schema(
  {
    socialMedia: [
      {
        platform: { type: String },
        handle: { type: String },
        tier: { type: String },
        followersCount: { type: Number },
      },
    ],
    googleMapAddress: { type: String },
    password: { type: String, required: true },
    brandName: { type: String, required: true },
    brandUsername: { type: String },
    email: { type: String, required: true, unique: true },
    phoneNumber: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    brandLogo: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // Cloudinary image objects
    isPremium: { type: Boolean, default: false },
    premiumDuration: {
      type: String,
      enum: ["1m", "3m", "1y", null],
      default: null,
    },
    premiumStart: { type: Date, default: null },
    premiumEnd: { type: Date, default: null },
    categories: [{ type: String }],
    languages: [{ type: String }],
    website: { type: String },
    location: {
      state: { type: String },
      googleMapLink: { type: String },
    },
    products: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // For premium brands, up to 3 product images
    contact: {
      whatsapp: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      call: { type: Boolean, default: false },
    },
    promotionalPrice: { type: Number },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "deleted"],
      default: "pending",
    },
  },
  { timestamps: true },
);
BrandSchema.index({ status: 1 });
BrandSchema.index({ brandName: 1 });

export const BrandModel = model("Brand", BrandSchema);

export const CategorySchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const CategoryModel = model("Category", CategorySchema);

export const StateSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const StateModel = model("State", StateSchema);

export const SocialMediaSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
  tiers: [{ type: String }],
});
export const SocialMediaModel = model("SocialMedia", SocialMediaSchema);

// Campaign schema
export const CampaignSchema = new Schema(
  {
    brandId: {
      type: Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    image: {
      url: { type: String },
      public_id: { type: String },
    },
    status: {
      type: String,
      enum: ["draft", "active", "completed"],
      default: "draft",
    },
    budgetMin: { type: Number },
    budgetMax: { type: Number },
    timelineStart: { type: Date },
    timelineEnd: { type: Date },
  },
  { timestamps: true },
);
CampaignSchema.index({ status: 1 });
export const CampaignModel = model("Campaign", CampaignSchema);

// Campaign Invite schema
export const CampaignInviteSchema = new Schema(
  {
    campaignId: {
      type: Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    brandId: {
      type: Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },
    influencerId: {
      type: Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
    },
    analytics: {
      reach: { type: Number },
      engagement: { type: Number },
      clicks: { type: Number },
    },
  },
  { timestamps: true },
);
export const CampaignInviteModel = model(
  "CampaignInvite",
  CampaignInviteSchema,
);
