import { Schema, Document } from "mongoose";

export const UsageCounterSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    userRole: {
      type: String,
      enum: ["brand", "influencer", "photographer"],
      required: true,
      index: true,
    },
    usageType: {
      type: String,
      enum: ["profile_view", "search"],
      required: true,
      index: true,
    },
    day: { type: String, required: true, index: true },
    used: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    limit: { type: Number, default: 0 },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

UsageCounterSchema.index(
  { userId: 1, userRole: 1, usageType: 1, day: 1 },
  { unique: true },
);

// Only today's row is ever read (daily search/profile-view limits); MongoDB
// deletes rows 90 days after they were created. Keeps 3 months for usage review.
export const USAGE_COUNTER_KEEP_DAYS = 90;
UsageCounterSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: USAGE_COUNTER_KEEP_DAYS * 24 * 60 * 60 },
);

export interface UsageCounter extends Document {
  userId: string;
  userRole: "brand" | "influencer" | "photographer";
  usageType: "profile_view" | "search";
  day: string;
  used: number;
  remaining: number;
  limit: number;
  meta: Record<string, any>;
}
