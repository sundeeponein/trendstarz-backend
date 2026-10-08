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
