import { Schema } from "mongoose";

// Distinct from the pre-existing, unrelated `verificationAuditLog` array
// embedded on profile docs (profile.schemas.ts) — this one is specifically
// for Collaboration Score *settings* changes (admin edits, resets), not
// profile verification history.
export const COLLABORATION_SETTINGS_AUDIT_ACTIONS = ["settings_updated", "settings_reset"] as const;

export const CollaborationSettingsAuditLogSchema = new Schema(
  {
    action: { type: String, enum: COLLABORATION_SETTINGS_AUDIT_ACTIONS, required: true },
    actorId: { type: String, default: "" },
    actorRole: { type: String, default: "" },
    // Top-level keys touched by this change — cheap to scan without diffing
    // the full before/after snapshots below.
    changedFields: { type: [String], default: [] },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
  },
  { collection: "collaboration_settings_audit_logs", timestamps: true },
);

CollaborationSettingsAuditLogSchema.index({ createdAt: -1 });
