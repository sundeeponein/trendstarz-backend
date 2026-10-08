/**
 * Authoritative TrendStarZ marketplace event types.
 *
 * PlatformEvents are written server-side only, AFTER the underlying business
 * action has been persisted. They are separate from AnalyticsEvent
 * (browser-reported GA4/Clarity funnel events — see
 * campaigns/analytics-events.service.ts), which stays as-is.
 */
export const PLATFORM_EVENT_TYPES = [
  "campaign_created",
  "creator_invited",
  "invite_viewed",
  "invite_accepted",
  "invite_declined",
  "creator_applied",
  // Reserved: there is currently no distinct "host selects a creator" action
  // (open-campaign applications are accepted by the creator, invite-only
  // campaigns select by inviting). Not emitted anywhere yet.
  "creator_selected",
  "content_submitted",
  "content_approved",
  "content_rejected",
  "campaign_completed",
  "payment_completed",
  // Stage 1.5 — lifecycle exits and intermediate steps, so funnels can explain
  // drop-offs instead of invites silently disappearing between steps.
  "invite_withdrawn",
  "counter_offer_sent",
  "work_started",
  "content_disputed",
  // Stage 3D-1c — the campaign owner declined the creator's counter-offer (the
  // invite goes back to pending; before this it left no trace).
  "counter_offer_declined",
] as const;

/**
 * Why an invite ended as "withdrawn" — every code path that sets that status
 * maps to exactly one of these (metadata.reason on invite_withdrawn).
 */
export const INVITE_WITHDRAWN_REASONS = [
  "owner", // campaign owner withdrew it
  "auto_close", // all slots for the role were filled by other acceptances
  "expired_unsubmitted", // accepted but never submitted before the deadline / campaign end
  "expired_never_accepted", // still unanswered when the campaign ended
  "dispute_refund", // dispute resolved in the owner's favour (admin, creator or auto-cancel)
  "admin_cancel", // admin cancelled the campaign's participation
] as const;

export type InviteWithdrawnReason = (typeof INVITE_WITHDRAWN_REASONS)[number];

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

/** Who performed the action. "system" = cron/webhook/auto-transition, no human actor. */
export const PLATFORM_EVENT_ACTOR_ROLES = [
  "brand",
  "influencer",
  "photographer",
  "admin",
  "system",
] as const;

export type PlatformEventActorRole =
  (typeof PLATFORM_EVENT_ACTOR_ROLES)[number];

export const PLATFORM_EVENT_RECIPIENT_ROLES = [
  "influencer",
  "photographer",
] as const;

export type PlatformEventRecipientRole =
  (typeof PLATFORM_EVENT_RECIPIENT_ROLES)[number];

export function isPlatformEventType(
  value: unknown,
): value is PlatformEventType {
  return (PLATFORM_EVENT_TYPES as readonly string[]).includes(String(value));
}
