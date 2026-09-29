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
] as const;

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
