import { Schema } from "mongoose";
import {
  PLATFORM_EVENT_ACTOR_ROLES,
  PLATFORM_EVENT_RECIPIENT_ROLES,
  PLATFORM_EVENT_TYPES,
} from "../../platform-events/platform-event-types";

/**
 * Append-only marketplace history (collection: platform_events).
 *
 * Unlike campaigns/invites/submissions — which only hold their latest state —
 * each row here is one business action at one point in time. Written only by
 * PlatformEventsService; never exposed to a public write API.
 *
 * All entity references are real ObjectIds (never the Mixed string/ObjectId/
 * username values the older collections allow). A legacy reference that isn't
 * a valid ObjectId is kept in metadata.legacyIds instead of being dropped.
 */
export const PlatformEventSchema = new Schema(
  {
    eventType: { type: String, enum: PLATFORM_EVENT_TYPES, required: true },
    // When the business action happened (for backfilled rows: the historical time).
    timestamp: { type: Date, required: true },

    // Actor — who performed the action. Null for system actions.
    userId: { type: Schema.Types.ObjectId, default: null },
    userRole: { type: String, enum: PLATFORM_EVENT_ACTOR_ROLES, default: null },

    // Campaign owner (brand or photographer — see metadata.ownerType), matching Campaign.brandId.
    brandId: { type: Schema.Types.ObjectId, default: null },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", default: null },
    // Invite recipient (influencer or photographer — see recipientRole), matching CampaignInvite.influencerId.
    influencerId: { type: Schema.Types.ObjectId, default: null },
    recipientRole: {
      type: String,
      enum: PLATFORM_EVENT_RECIPIENT_ROLES,
      default: null,
    },
    inviteId: {
      type: Schema.Types.ObjectId,
      ref: "CampaignInvite",
      default: null,
    },

    // Social platform the event concerns (instagram, youtube, …) — null when not applicable.
    platform: { type: String, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },

    // Set for events that can only happen once (e.g. "invite_accepted:<inviteId>").
    // Unique, so webhook retries, page refreshes and re-run backfills can't duplicate them.
    dedupeKey: { type: String },
  },
  {
    // createdAt = when the row was written (differs from `timestamp` for backfilled rows).
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
  },
);

// Per-entity timelines / metrics ("everything for this campaign/creator/brand, newest first").
PlatformEventSchema.index({ campaignId: 1, timestamp: -1 });
PlatformEventSchema.index({ influencerId: 1, timestamp: -1 });
PlatformEventSchema.index({ brandId: 1, timestamp: -1 });
// Per-invite funnel (invited → viewed → accepted → submitted → approved → paid).
PlatformEventSchema.index({ inviteId: 1, timestamp: 1 });
// Marketplace-wide counts per event type over a date range.
PlatformEventSchema.index({ eventType: 1, timestamp: -1 });
// Plain time-range scans across all types.
PlatformEventSchema.index({ timestamp: -1 });
PlatformEventSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);
