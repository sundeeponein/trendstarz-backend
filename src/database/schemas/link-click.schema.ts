import { Schema } from "mongoose";

export const LinkClickSchema = new Schema({
  trackingLinkId: { type: Schema.Types.ObjectId, required: true, index: true },
  clickedAt: { type: Date, default: Date.now, index: true },
  // Hashed, not raw IP — enough to de-dupe unique visitors without storing PII.
  ipHash: { type: String, default: "" },
  userAgent: { type: String, default: "" },
  referrer: { type: String, default: "" },
  deviceType: { type: String, enum: ["mobile", "tablet", "desktop", "other"], default: "other" },
});
