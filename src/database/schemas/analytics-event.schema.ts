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

// The "campaign completed" duplicate check (analytics-events.service) looks up
// by these three on every save; without an index that scans the collection.
AnalyticsEventSchema.index({ eventType: 1, "metadata.inviteId": 1, "metadata.completionStage": 1 });
AnalyticsEventSchema.index({ timestamp: -1 });

// Kept 45 days (decided 2026-10-23): nothing server-side reads these; GA4 and
// Clarity hold the long-term history. MongoDB removes older rows itself.
export const ANALYTICS_EVENT_RETENTION_DAYS = 45;
AnalyticsEventSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: ANALYTICS_EVENT_RETENTION_DAYS * 24 * 60 * 60 },
);
