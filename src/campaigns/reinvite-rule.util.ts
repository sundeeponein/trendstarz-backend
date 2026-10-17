/**
 * Server copy of the re-invite rule in the frontend's
 * shared/campaigns/invite-state.util.ts, for one creator on one campaign:
 *
 *   any invite still in play  → already invited
 *   declined (none active)    → not re-invitable
 *   only withdrawn/expired    → can be invited again
 *
 * The partial unique index built by cron/applyUniqueIndexes.js covers every
 * status except these two, so the database allows at most one active invite
 * per campaign + recipient.
 */
export const INACTIVE_INVITE_STATUSES = ["declined", "withdrawn"] as const;

/** Every CampaignInvite status that keeps an invite "active" for this rule. */
export const ACTIVE_INVITE_STATUSES = [
  "pending",
  "invited",
  "counter_sent",
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "completed",
  "approved",
  "disputed",
] as const;

/** Why this creator can't be invited again, or null when they can. */
export function reinviteBlockReason(existingInvites: any[]): string | null {
  const statuses = (existingInvites || []).map((i) =>
    String(i?.status || "").toLowerCase(),
  );
  if (!statuses.length) return null;
  if (
    statuses.some(
      (s) => !(INACTIVE_INVITE_STATUSES as readonly string[]).includes(s),
    )
  ) {
    return "This creator has already been invited to this campaign.";
  }
  if (statuses.includes("declined")) {
    return "This creator declined this campaign and can't be invited again.";
  }
  return null;
}
