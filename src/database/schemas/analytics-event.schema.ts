import { Schema } from "mongoose";

export const AnalyticsEventSchema = new Schema({
  eventType: {
    type: String,
    enum: ["campaign_invite_sent", "campaign_completed"],
    required: true,
  },
  timestamp: { type: Date, required: true },
  userId: { type: String },
  userRole: { type: String },
  metadata: { type: Schema.Types.Mixed, default: {} },
  receivedAt: { type: Date, default: Date.now },
});
