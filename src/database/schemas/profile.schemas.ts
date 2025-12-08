import { Schema, Types, model } from 'mongoose';

export const TierSchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String },
  desc: { type: String },
  showInFrontend: { type: Boolean, default: true },
});
export const TierModel = model('Tier', TierSchema);

// Language schema
export const LanguageSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const LanguageModel = model('Language', LanguageSchema);

// User schema (for admin and future users)
export const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
});
export const UserModel = model('User', UserSchema);

// All schema definitions go here (LanguageSchema, UserSchema, etc.)
export const InfluencerSchema = new Schema({
  password: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  profileImages: [{ type: String }], // Cloudinary URLs
  isPremium: { type: Boolean, default: false },
  premiumDuration: { type: String, enum: ['1m', '3m', '1y', null], default: null }, // 1 month, 3 months, 1 year
  categories: [{ type: String }],
  location: {
    state: { type: String },
  },
  socialMedia: [{
    platform: { type: String },
    handle: { type: String },
    tier: { type: String },
    followersCount: { type: Number },
  }],
  contact: {
    whatsapp: { type: Boolean, default: false },
    email: { type: Boolean, default: false },
    call: { type: Boolean, default: false },
  },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'deleted'], default: 'pending' },
}, { timestamps: true });

export const InfluencerModel = model('Influencer', InfluencerSchema);

export const BrandSchema = new Schema({
  password: { type: String, required: true },
  brandName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  brandLogo: [{ type: String }], // Cloudinary URLs
  isPremium: { type: Boolean, default: false },
  premiumDuration: { type: String, enum: ['1m', '3m', '1y', null], default: null },
  categories: [{ type: String }],
  location: {
    state: { type: String },
    googleMapLink: { type: String },
  },
  products: [{ type: String }], // For premium brands, up to 3 product images
  contact: {
    whatsapp: { type: Boolean, default: false },
    email: { type: Boolean, default: false },
    call: { type: Boolean, default: false },
  },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'deleted'], default: 'pending' },
}, { timestamps: true });

export const BrandModel = model('Brand', BrandSchema);

export const CategorySchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const CategoryModel = model('Category', CategorySchema);

export const StateSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const StateModel = model('State', StateSchema);


export const SocialMediaSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
  tiers: [{ type: String }],
});
export const SocialMediaModel = model('SocialMedia', SocialMediaSchema);
