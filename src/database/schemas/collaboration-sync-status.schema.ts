import { Schema } from "mongoose";

// One doc per user — tracks the "Sync Latest Profile" free comparison step
// (see collaboration-score.service.ts's syncLatestProfile/recordSyncBaseline),
// entirely separate from CollaborationAudit. Never scored, never charged,
// never creates history — this is purely a diff gate in front of the paid
// Re-analyze flow. Keyed by the same platform names as
// COLLABORATION_AUDIT_PLATFORMS ("YouTube"/"Instagram"/"Facebook"/"LinkedIn").
//
// Deliberately does NOT store a "connected" flag per platform — that's
// already correctly derived elsewhere (SocialOAuthConnection for
// Instagram/Facebook, profile.socialMedia for YouTube); duplicating it here
// would just be a second source of truth that can drift.
const SyncPlatformStatusSchema = new Schema(
  {
    lastSyncedAt: { type: Date, default: null },
    hasChanges: { type: Boolean, default: false },
    // Hash of the snapshot taken at the most recent Sync click.
    snapshotHash: { type: String, default: null },
    // Hash of the snapshot captured at the most recent real audit (free or
    // paid) — this is what a Sync's fresh snapshot is actually compared
    // against, per recordSyncBaseline().
    lastAuditHash: { type: String, default: null },
    latestSnapshot: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

export const CollaborationSyncStatusSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true },
    platforms: { type: Map, of: SyncPlatformStatusSchema, default: () => ({}) },
  },
  { collection: "collaboration_sync_status", timestamps: true },
);

CollaborationSyncStatusSchema.index({ userId: 1 }, { unique: true });
