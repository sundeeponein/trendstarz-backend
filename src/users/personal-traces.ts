/**
 * Records about one person kept OUTSIDE their profile, removed when the
 * account is deleted or anonymized ([collection, field holding the account id,
 * how that id is stored]). Financial records (payments, campaign transactions,
 * subscriptions) and invites are never listed here: they are kept for
 * accounting. usage_counters expire on their own (90-day TTL).
 *
 * Mirrored in cron/orphanPersonalData.js — keep both lists the same.
 */
export const PERSONAL_TRACES: Array<[collection: string, field: string, idType: "string" | "objectId"]> = [
  ["notifications", "userId", "string"],
  ["pushsubscriptions", "userId", "string"],
  ["notificationpreferences", "userId", "string"],
  // Moderation flags: admin notes and messages about the person.
  ["profile_flags", "userId", "string"],
  ["collaboration_sync_status", "userId", "string"],
  // Their social handles, follower counts and review notes.
  ["social_account_observations", "profileId", "string"],
  ["social_account_observation_history", "profileId", "string"],
  ["social_account_verifications", "profileId", "string"],
  ["social_account_reviews", "profileId", "string"],
  // Their own profile statistics (clicks they made on others stay in those
  // people's statistics).
  ["profile_traffic_daily", "profileId", "string"],
  ["social_profile_clicks", "targetUserId", "objectId"],
  // Which Premium offer emails they were sent.
  ["offer_email_sends", "userId", "string"],
];
