import { Schema } from "mongoose";

export const CampaignInviteSchema = new Schema({
  campaignId: { type: Schema.Types.Mixed, ref: "Campaign", required: true },
  influencerId: {
    type: Schema.Types.ObjectId,
    ref: "Influencer",
    required: true,
  },
  brandId: { type: Schema.Types.Mixed, ref: "Brand", required: true }, // Allow ObjectId or string
  status: {
    type: String,
    enum: [
      "pending",
      "accepted",
      "declined",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "disputed",
    ],
    default: "pending",
  },
  analytics: {
    reach: Number,
    engagement: Number,
    clicks: Number,
  },
  selectedPostDate: { type: Date },
  acceptedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
