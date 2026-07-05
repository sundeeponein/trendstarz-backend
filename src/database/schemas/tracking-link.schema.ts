import { Schema } from "mongoose";

// One tracking link per accepted invite. `hostType`/`recipientType` make this
// reusable across every role that can own or receive a campaign/collab today
// (brand or photographer as host; influencer or photographer as recipient).
export const TrackingLinkSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  campaignId: { type: Schema.Types.Mixed, required: true, index: true },
  inviteId: { type: Schema.Types.Mixed, required: true, unique: true, index: true },
  hostId: { type: Schema.Types.Mixed, required: true, index: true },
  hostType: { type: String, enum: ["brand", "photographer"], required: true },
  recipientId: { type: Schema.Types.Mixed, required: true, index: true },
  recipientType: { type: String, enum: ["influencer", "photographer"], required: true },
  // Free-text, not enum — new social platforms/content types shouldn't need a schema change.
  platform: { type: String, default: "" },
  contentType: { type: String, default: "" },
  destinationUrl: { type: String, required: true },
  // Matches Campaign.promotionUrlType — what kind of destination this link points at.
  destinationType: {
    type: String,
    enum: ["website", "app_store", "play_store", "instagram", "facebook", "youtube", "whatsapp", "other"],
    default: "other",
  },
  // Not used by anything today — only "campaign" exists. Reserved so referral links,
  // affiliate links, event registrations etc. can reuse this same collection later
  // without a schema migration.
  moduleType: {
    type: String,
    enum: ["campaign", "collaboration", "referral"],
    default: "campaign",
    index: true,
  },
  clickCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
