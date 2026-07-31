import { Schema } from "mongoose";

// One row per (link, user, conversion stage). "signup" is written once when a user
// registers through a referral tracking link; "premium_purchase"/"campaign_payment"
// are written later, looked up by the user's earlier "signup" row, when that same
// user converts further. Written via upsert so re-verification (e.g. a payment
// webhook firing twice) never produces duplicate rows.
export const LinkConversionSchema = new Schema({
  trackingLinkId: { type: Schema.Types.ObjectId, ref: "TrackingLink", required: true, index: true },
  userId: { type: Schema.Types.Mixed, required: true, index: true },
  userType: { type: String, enum: ["brand", "influencer", "photographer"], required: true },
  conversionType: {
    type: String,
    enum: ["signup", "premium_purchase", "campaign_payment"],
    required: true,
  },
  // Paise, same unit convention as Payment.amount — only set for premium_purchase/campaign_payment.
  amount: { type: Number },
  paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
  campaignTransactionId: { type: Schema.Types.ObjectId, ref: "CampaignTransaction" },
  convertedAt: { type: Date, default: Date.now },
});

LinkConversionSchema.index({ trackingLinkId: 1, userId: 1, conversionType: 1 }, { unique: true });
LinkConversionSchema.index({ userId: 1, conversionType: 1 });
