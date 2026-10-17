import { SocialDecisionView } from "../social-account-verification/social-account-verification.service";
import { handleIdentity } from "../social-account-verification/social-account-verification.service";
import { SocialAccountObservationView } from "../social-account-observation/social-account-observation.service";
import {
  normalizeFacebookPageRef,
  normalizeInstagramHandle,
  parseYouTubeIdentifier,
} from "../social-account-observation/platform-observers";
import {
  derivePlatformKey,
  isSocialAccountId,
} from "../utils/social-account.util";
import { resolveTier, tierForFollowers } from "../utils/tier-ranges.util";

/**
 * Stage 3A-3 — DECLARED vs VERIFIED vs OBSERVED, side by side (admin only).
 *
 * Pure and deterministic: computed on read from the three existing sources
 * (profile.socialMedia[], Stage 3A-1 decisions, Stage 3A-2 observations).
 * Nothing here is stored, and nothing here changes any of the three — a
 * "mismatch" is an informational signal for a human reviewer, never an action.
 */

/** Neutral comparison outcome. */
export type ComparisonStatus = "match" | "mismatch" | "not_available";

export interface TierRef {
  key: string;
  label: string;
}

export interface SocialAccountComparison {
  socialAccountId: string | null;
  platform: string;
  platformKey: string;

  declared: {
    handle: string;
    tier: string;
    /** null = not declared (Stage 3A-0: followersCount is server-owned and defaults to 0). */
    followersCount: number | null;
    selfReportedStats: {
      avgLikes: number | null;
      avgComments: number | null;
      postFrequencyPerWeek: number | null;
      lastUpdatedAt: Date | null;
    } | null;
  };

  verified: {
    ownership: VerifiedReview;
    tier: VerifiedReview;
  };

  observed: {
    available: boolean;
    requiresConnection: boolean;
    connected: boolean | null;
    lastAttempt: {
      status: "success" | "failed";
      at: Date | null;
      error: string | null;
    } | null;
    latest: {
      externalAccountId: string;
      observedHandle: string;
      /** null = the platform hides the count. */
      observedFollowersCount: number | null;
      source: string;
      capturedAt: Date;
      externalUrl: string;
    } | null;
  };

  comparison: {
    handle: {
      declared: string;
      observed: string | null;
      status: ComparisonStatus;
    };
    tier: {
      declared: TierRef | null;
      /** Only an admin-VERIFIED tier counts here; pending/rejected → null. */
      verified: TierRef | null;
      /** Derived from observed followers for comparison only — never written anywhere. */
      observed: TierRef | null;
      declaredVsObserved: ComparisonStatus;
      verifiedVsObserved: ComparisonStatus;
    };
    followers: {
      declared: number | null;
      observed: number | null;
      comparisonAvailable: boolean;
      /** observed − declared, only when both are known. */
      difference: number | null;
    };
  };
}

export interface VerifiedReview {
  status: "pending" | "verified" | "rejected";
  method: string | null;
  /** Ownership: the handle that was reviewed. */
  reviewedHandle?: string | null;
  /** Tier: the declared tier that was reviewed. */
  reviewedTier?: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  note: string | null;
  /** Pending because the handle/tier changed since the last decision. */
  changedSinceReview: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tierRef(raw: unknown): TierRef | null {
  const tier = resolveTier(raw);
  return tier ? { key: tier.key, label: tier.label } : null;
}

/**
 * The canonical tier for an observed count. 0 is a real observed count below
 * every bucket (the canonical tiers start at 1); null means "hidden/unknown".
 */
export function observedTierFor(followers: number | null): TierRef | null {
  if (followers === null) return null;
  if (followers === 0)
    return { key: "below_starter", label: "Below Starter (0)" };
  const tier = tierForFollowers(followers);
  return tier ? { key: tier.key, label: tier.label } : null;
}

function compareTiers(a: TierRef | null, b: TierRef | null): ComparisonStatus {
  if (!a || !b) return "not_available";
  return a.key === b.key ? "match" : "mismatch";
}

/**
 * Platform-aware comparable forms of a handle. Removes only harmless
 * differences (spacing, "@", case, profile-URL wrapping); a YouTube channel id
 * or Facebook page id compares against the observed external account id.
 */
function declaredHandleKeys(platformKey: string, raw: unknown): string[] {
  if (platformKey === "youtube") {
    const id = parseYouTubeIdentifier(raw);
    if (id)
      return [
        id.kind === "channelId" ? `id:${id.value}` : id.value.toLowerCase(),
      ];
  } else if (platformKey === "instagram") {
    const h = normalizeInstagramHandle(raw);
    if (h) return [h];
  } else if (platformKey === "facebook") {
    const ref = normalizeFacebookPageRef(raw);
    if (ref) return [/^\d+$/.test(ref) ? `id:${ref}` : ref];
  }
  const fallback = handleIdentity(raw);
  return fallback ? [fallback] : [];
}

function observedHandleKeys(
  platformKey: string,
  observedHandle: string,
  externalAccountId: string,
): string[] {
  const keys = new Set<string>();
  const handle = handleIdentity(observedHandle);
  if (handle)
    keys.add(
      /^\d+$/.test(handle) && platformKey === "facebook"
        ? `id:${handle}`
        : handle,
    );
  if (
    externalAccountId &&
    (platformKey === "youtube" || platformKey === "facebook")
  ) {
    keys.add(`id:${externalAccountId}`);
  }
  return [...keys];
}

function verifiedReview(
  reviewType: "ownership" | "tier",
  decision: SocialDecisionView | null | undefined,
): VerifiedReview {
  const d = decision || { status: "pending" as const };
  const decided = d.status !== "pending";
  const review: VerifiedReview = {
    status: d.status,
    method: decided ? (d.method ?? null) : null,
    reviewedAt: decided ? (d.decidedAt ?? null) : null,
    reviewedBy: decided ? (d.decidedByName ?? null) : null,
    note: decided ? (d.note ?? null) : null,
    changedSinceReview: !decided && !!(d.stale || d.invalidatedAt),
  };
  if (reviewType === "ownership")
    review.reviewedHandle = decided ? (d.decidedHandle ?? null) : null;
  else review.reviewedTier = decided ? (d.decidedTier ?? null) : null;
  return review;
}

export function buildSocialAccountComparison(
  entry: Record<string, any>,
  verification: {
    ownershipVerification?: SocialDecisionView | null;
    tierVerification?: SocialDecisionView | null;
  } | null,
  observation: SocialAccountObservationView | null,
): SocialAccountComparison {
  const platformKey = String(
    entry.platformKey || derivePlatformKey(entry.platform),
  );
  const stats = entry.selfReportedStats;

  // ── DECLARED (creator profile, as stored) ──
  const declared: SocialAccountComparison["declared"] = {
    handle: String(entry.handle ?? ""),
    tier: String(entry.tier ?? ""),
    followersCount: positiveCount(entry.followersCount),
    selfReportedStats:
      stats && typeof stats === "object"
        ? {
            avgLikes: nullableNumber(stats.avgLikes),
            avgComments: nullableNumber(stats.avgComments),
            postFrequencyPerWeek: nullableNumber(stats.postFrequencyPerWeek),
            lastUpdatedAt: stats.lastUpdatedAt
              ? new Date(stats.lastUpdatedAt)
              : null,
          }
        : null,
  };

  // ── VERIFIED (Stage 3A-1 admin decisions, already validity-checked) ──
  const verified = {
    ownership: verifiedReview("ownership", verification?.ownershipVerification),
    tier: verifiedReview("tier", verification?.tierVerification),
  };

  // ── OBSERVED (Stage 3A-2 latest successful observation + latest attempt) ──
  const o = observation?.observation ?? null;
  const latest = o?.latest
    ? {
        externalAccountId: String(o.latest.externalAccountId ?? ""),
        observedHandle: String(o.latest.observedHandle ?? ""),
        observedFollowersCount: nonNegativeCount(
          o.latest.observedFollowersCount,
        ),
        source: String(o.latest.source ?? ""),
        capturedAt: o.latest.capturedAt,
        externalUrl: String(o.latest.externalUrl ?? ""),
      }
    : null;
  const observed: SocialAccountComparison["observed"] = {
    available: !!latest,
    requiresConnection: !!observation?.requiresConnection,
    connected: observation?.connected ?? null,
    lastAttempt: o
      ? {
          status: o.status,
          at: o.lastAttemptAt ?? null,
          error: o.lastError ?? null,
        }
      : null,
    latest,
  };

  // ── COMPARISON (derived, never stored) ──
  let handleStatus: ComparisonStatus = "not_available";
  if (latest && text(declared.handle)) {
    const declaredKeys = declaredHandleKeys(platformKey, declared.handle);
    const observedKeys = observedHandleKeys(
      platformKey,
      latest.observedHandle,
      latest.externalAccountId,
    );
    if (declaredKeys.length && observedKeys.length) {
      handleStatus = declaredKeys.some((k) => observedKeys.includes(k))
        ? "match"
        : "mismatch";
    }
  }

  const declaredTier = tierRef(declared.tier);
  const verifiedTier =
    verified.tier.status === "verified"
      ? tierRef(verified.tier.reviewedTier)
      : null;
  const observedFollowers = latest ? latest.observedFollowersCount : null;
  const observedTier = observedTierFor(observedFollowers);

  const followersAvailable =
    declared.followersCount !== null && observedFollowers !== null;

  return {
    socialAccountId: isSocialAccountId(entry.socialAccountId)
      ? entry.socialAccountId
      : null,
    platform: String(entry.platform ?? ""),
    platformKey,
    declared,
    verified,
    observed,
    comparison: {
      handle: {
        declared: declared.handle,
        observed: latest ? latest.observedHandle : null,
        status: handleStatus,
      },
      tier: {
        declared: declaredTier,
        verified: verifiedTier,
        observed: observedTier,
        declaredVsObserved: compareTiers(declaredTier, observedTier),
        verifiedVsObserved: compareTiers(verifiedTier, observedTier),
      },
      followers: {
        declared: declared.followersCount,
        observed: observedFollowers,
        comparisonAvailable: followersAvailable,
        difference:
          observedFollowers !== null && declared.followersCount !== null
            ? observedFollowers - declared.followersCount
            : null,
      },
    },
  };
}
