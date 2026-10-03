import { Schema } from "mongoose";

// A tracking link is either per-accepted-invite (moduleType "campaign"/"collaboration",
// campaignId/inviteId/recipientId always set) or a referral link (moduleType "referral",
// shared by any role to invite new signups — campaignId/inviteId/recipientId stay unset
// until, and unless, someone converts through it).
export const TrackingLinkSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  // Absent for referral links (moduleType "referral") — those aren't tied to a campaign/invite/recipient
  // until (and unless) someone signs up through them.
  campaignId: { type: Schema.Types.Mixed, index: true },
  // sparse: referral links must omit this field entirely (not set it to null) so multiple
  // referral rows don't collide on the unique index.
  inviteId: { type: Schema.Types.Mixed, unique: true, sparse: true, index: true },
  hostId: { type: Schema.Types.Mixed, required: true, index: true },
  hostType: { type: String, enum: ["brand", "influencer", "photographer"], required: true },
  recipientId: { type: Schema.Types.Mixed, index: true },
  recipientType: { type: String, enum: ["influencer", "photographer", "brand"] },
  // Free-text, not enum — new social platforms/content types shouldn't need a schema change.
  platform: { type: String, default: "" },
  contentType: { type: String, default: "" },
  destinationUrl: { type: String, required: true },
  // Matches Campaign.promotionUrlType — what kind of destination this link points at.
  // "registration" = referral link pointing at a signup page.
  destinationType: {
    type: String,
    enum: [
      "website",
      "app_store",
      "play_store",
      "instagram",
      "facebook",
      "youtube",
      "whatsapp",
      "registration",
      "other",
    ],
    default: "other",
  },
  // Role being referred (brand/influencer/photographer) — only set for moduleType "referral".
  destinationRole: { type: String, enum: ["brand", "influencer", "photographer"] },
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
