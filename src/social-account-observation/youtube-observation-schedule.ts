import { isApprovedActiveAccount } from "../utils/profile-eligibility.util";
import {
  derivePlatformKey,
  isSocialAccountId,
} from "../utils/social-account.util";

/**
 * Stage 3D-1a — which YouTube accounts the schedule should observe now (pure).
 *
 * Decided with the product owner (2026-10-06):
 *   population  approved, active creators + creators awaiting admin review
 *   cadence     weekly refresh per account
 *   retention   YouTube follower counts are kept ≤ 30 days (purged separately)
 *
 * No platform calls, no DB, no clock other than `now`. The scheduler service
 * loads the data and performs the observations; this only plans them.
 */
export const YOUTUBE_SCHEDULE = {
  /** A successfully observed account is refreshed after this many days. */
  refreshEveryDays: 7,
  /** A failed attempt is retried after this many days (until paused). */
  retryAfterDays: 1,
  /** Consecutive "wrong account" failures before automatic retries pause. */
  pauseAfterIdentityFailures: 3,
  /** A paused account is still retried this often (the handle may be fixed). */
  pausedRetryAfterDays: 30,
  /** Hard cap on YouTube calls per run (channels.list = 1 quota unit each). */
  maxCallsPerRun: 100,
} as const;

/** Failures that mean the declared handle doesn't identify one channel. */
export const IDENTITY_FAILURES = [
  "external_account_not_found",
  "account_mismatch",
] as const;
/** Failures that stop the whole run (no point calling again today). */
export const STOP_RUN_FAILURES = [
  "rate_limited",
  "platform_not_configured",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Approved + active (the shared approval rule), or awaiting admin review —
 * the admin console's own "admin review pending" definition. Deleted,
 * declined and suspended profiles are never observed.
 */
export function isInObservationPopulation(
  profile: Record<string, any>,
): boolean {
  if (!profile || profile.isDeleted === true) return false;
  const status = text(profile.status).toLowerCase();
  if (status === "declined" || status === "deleted") return false;
  if (text(profile.accountStatus).toLowerCase() === "suspended") return false;
  if (isApprovedActiveAccount(profile)) return true;
  return (
    text(profile.verificationStatus).toLowerCase() === "pending" ||
    profile.adminReviewPending === true
  );
}

export interface HistoryAttempt {
  status: string;
  reason?: string | null;
  capturedAt: Date | string;
}

/** Identity failures in a row, newest first, until a success or another failure kind. */
export function consecutiveIdentityFailures(
  newestFirst: HistoryAttempt[],
): number {
  let n = 0;
  for (const a of newestFirst) {
    if (
      a.status === "failed" &&
      (IDENTITY_FAILURES as readonly string[]).includes(String(a.reason))
    )
      n++;
    else break;
  }
  return n;
}

export type DueReason = "never_observed" | "refresh" | "retry" | "paused_retry";

export interface ScheduledAccount {
  profileType: "Influencer" | "Photographer";
  profileId: string;
  socialAccountId: string;
  entry: Record<string, any>;
  lastAttemptAt: Date | null;
}

export interface YoutubeRunPlan {
  /** YouTube accounts in the population. */
  candidates: number;
  /** To observe now, oldest first, capped at maxCallsPerRun. */
  due: Array<ScheduledAccount & { reason: DueReason }>;
  /** Due but beyond this run's cap (picked up next run). */
  deferred: number;
  /** Automatic retries paused: the handle repeatedly matched no single channel. */
  paused: Array<
    ScheduledAccount & {
      consecutiveFailures: number;
      lastError: string | null;
      nextRetryAt: Date;
    }
  >;
  notDue: number;
}

export interface PlanInput {
  now: Date;
  profiles: Array<{
    profileType: "Influencer" | "Photographer";
    profile: Record<string, any>;
  }>;
  /** Current observation docs keyed by `${profileType}|${profileId}|${socialAccountId}`. */
  current: Map<string, Record<string, any>>;
  /** History attempts (newest first) keyed the same way. */
  history: Map<string, HistoryAttempt[]>;
}

export const accountKey = (
  profileType: string,
  profileId: string,
  socialAccountId: string,
) => `${profileType}|${profileId}|${socialAccountId}`;

export function planYoutubeObservationRun(input: PlanInput): YoutubeRunPlan {
  const { now } = input;
  const days = (n: number) => n * DAY_MS;
  const due: YoutubeRunPlan["due"] = [];
  const paused: YoutubeRunPlan["paused"] = [];
  let candidates = 0;
  let notDue = 0;

  for (const { profileType, profile } of input.profiles) {
    if (!isInObservationPopulation(profile)) continue;
    const profileId = String(profile._id ?? "");
    for (const raw of Array.isArray(profile.socialMedia)
      ? profile.socialMedia
      : []) {
      const entry =
        raw && typeof raw.toObject === "function" ? raw.toObject() : raw;
      if (
        derivePlatformKey(entry?.platformKey || entry?.platform) !== "youtube"
      )
        continue;
      if (!isSocialAccountId(entry?.socialAccountId)) continue;
      candidates++;
      const key = accountKey(profileType, profileId, entry.socialAccountId);
      const doc = input.current.get(key);
      const lastAttemptAt = doc?.lastAttemptAt
        ? new Date(doc.lastAttemptAt)
        : null;
      const account: ScheduledAccount = {
        profileType,
        profileId,
        socialAccountId: entry.socialAccountId,
        entry,
        lastAttemptAt,
      };
      const since =
        lastAttemptAt && !Number.isNaN(lastAttemptAt.getTime())
          ? now.getTime() - lastAttemptAt.getTime()
          : null;

      if (since === null) {
        due.push({ ...account, reason: "never_observed" });
        continue;
      }
      if (doc?.status === "failed") {
        const failures = consecutiveIdentityFailures(
          input.history.get(key) || [],
        );
        if (failures >= YOUTUBE_SCHEDULE.pauseAfterIdentityFailures) {
          if (since >= days(YOUTUBE_SCHEDULE.pausedRetryAfterDays)) {
            due.push({ ...account, reason: "paused_retry" });
          } else {
            paused.push({
              ...account,
              consecutiveFailures: failures,
              lastError: doc.lastError ?? null,
              nextRetryAt: new Date(
                lastAttemptAt!.getTime() +
                  days(YOUTUBE_SCHEDULE.pausedRetryAfterDays),
              ),
            });
          }
          continue;
        }
        if (since >= days(YOUTUBE_SCHEDULE.retryAfterDays))
          due.push({ ...account, reason: "retry" });
        else notDue++;
        continue;
      }
      if (since >= days(YOUTUBE_SCHEDULE.refreshEveryDays))
        due.push({ ...account, reason: "refresh" });
      else notDue++;
    }
  }

  // Never-observed first, then the longest-waiting; key for a stable order.
  const ts = (a: ScheduledAccount) =>
    a.lastAttemptAt ? a.lastAttemptAt.getTime() : -Infinity;
  const ordered = due.sort(
    (a, b) =>
      ts(a) - ts(b) ||
      (accountKey(a.profileType, a.profileId, a.socialAccountId) <
      accountKey(b.profileType, b.profileId, b.socialAccountId)
        ? -1
        : 1),
  );
  return {
    candidates,
    due: ordered.slice(0, YOUTUBE_SCHEDULE.maxCallsPerRun),
    deferred: Math.max(0, ordered.length - YOUTUBE_SCHEDULE.maxCallsPerRun),
    paused,
    notDue,
  };
}
