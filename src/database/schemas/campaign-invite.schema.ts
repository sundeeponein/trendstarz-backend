import { Schema } from 'mongoose';

export const CampaignInviteSchema = new Schema({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
  influencerId: { type: Schema.Types.ObjectId, ref: 'Influencer', required: true },
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  status: { type: String, enum: ['invited', 'accepted', 'declined', 'submitted', 'completed'], default: 'invited' },
  analytics: {
    reach: Number,
    engagement: Number,
    clicks: Number,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
