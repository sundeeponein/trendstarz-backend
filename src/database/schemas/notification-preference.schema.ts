import { Schema } from "mongoose";

/** Account-level push notification preference, split by device and event category. */
export const NotificationPreferenceSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    webEnabled: { type: Boolean, default: true },
    mobileEnabled: { type: Boolean, default: true },
    campaignEnabled: { type: Boolean, default: true },
    paymentEnabled: { type: Boolean, default: true },
    whatsappEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);
