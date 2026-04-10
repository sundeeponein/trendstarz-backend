import { Schema } from 'mongoose';

export const CampaignInviteSchema = new Schema({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
  influencerId: { type: Schema.Types.ObjectId, ref: 'Influencer', required: true },
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'submitted', 'completed'], default: 'pending' },
  analytics: {
    reach: Number,
    engagement: Number,
    clicks: Number,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
