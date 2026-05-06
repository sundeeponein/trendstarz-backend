import { Schema } from "mongoose";

/** Stored Web Push subscription for a user (brand or influencer). */
export const PushSubscriptionSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    userRole: { type: String, enum: ["brand", "influencer", "admin"] },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true },
);
