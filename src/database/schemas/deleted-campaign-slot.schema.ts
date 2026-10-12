import { Schema } from "mongoose";

/**
 * A live campaign that its host deleted still used one of their monthly
 * campaign slots — the campaign document is gone, so this row keeps it counted
 * (see CampaignsService.campaignSlotUsage).
 */
export const DeletedCampaignSlotSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true },
    /** When the campaign took the slot (its slotUsedAt, else createdAt). */
    slotUsedAt: { type: Date, required: true, index: true },
    deletedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
