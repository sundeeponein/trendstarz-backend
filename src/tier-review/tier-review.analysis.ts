import {
  Freshness,
  observationFreshness,
  verificationState,
} from "../matching-evidence/evidence-quality.analysis";
import { normalizeCreatorMatchInput } from "../matching-inputs/matching-inputs";
import { connectedPlatformsFrom } from "../social-account-observation/platform-observers";
import { observationView } from "../social-account-observation/social-account-observation.service";
import {
  TierRef,
  buildSocialAccountComparison,
} from "../social-account-comparison/social-account-comparison";
import { effectiveDecision } from "../social-account-verification/social-account-verification.service";

/**
 * Stage 3D-1b — tier review queue (pure, read-only).
 *
 * One list, across every approved creator, of the social accounts whose declared
 * tier needs an admin decision:
 *  1. changed_since_review — a verified/rejected tier no longer matches what the
 *     creator declares (they changed it after the review);
 *  2. observed_mismatch — a usable platform observation (fresh or stale, with a
 *     follower count) puts the account in a different tier than declared, and no
 *     decision has been made since that observation;
 *  3. never_reviewed — nobody has decided on the declared tier yet.
 * Oldest first within each group.
 *
 * Evidence only: the admin's decision (via the existing decide()) stays
 * authoritative. Every rule is reused from the module that owns it
 * (effectiveDecision, observationView, buildSocialAccountComparison,
 * observationFreshness, normalizeCreatorMatchInput) — the Matching Evidence page
 * counts the same accounts the same way.
 */

export const TIER_REVIEW_REASONS = [
  "changed_since_review",
  "observed_mismatch",
  "never_reviewed",
] as const;
export type TierReviewReason = (typeof TIER_REVIEW_REASONS)[number];

export interface TierReviewInput {
  asOf: Date;
  creators: Array<{
    profileType: "Influencer" | "Photographer";
    profile: Record<string, any>;
  }>;
  verifications: Array<Record<string, any>>;
  observations: Array<Record<string, any>>;
  connections: Array<{
    userId: unknown;
    userType: string;
    platform: string;
    instagramBusinessAccountId?: string | null;
  }>;
}

export interface TierReviewItem {
  reason: TierReviewReason;
  /** When the item became reviewable (oldest first): invalidation, observation or profile creation. */
  since: string | null;
  profileType: "Influencer" | "Photographer";
  profileId: string;
  creatorName: string;
  username: string;
  socialAccountId: string;
  platform: string;
  platformKey: string;
  handle: string;
  declaredTier: string;
  declaredTierRef: TierRef | null;
  decision: {
    status: string;
    decidedTier: string | null;
    decidedAt: string | null;
    decidedByName: string | null;
    evidenceBasis: string | null;
    invalidatedAt: string | null;
  };
  observed: {
    followers: number | null;
    tier: TierRef | null;
    capturedAt: string | null;
    freshness: Freshness;
    requiresConnection: boolean;
    connected: boolean | null;
    lastAttemptFailed: boolean;
    /** The exact page the platform resolved the account to (e.g. the YouTube channel). */
    externalUrl: string | null;
    /** Same channel found by its id under this new handle (the creator renamed it on YouTube). */
    handleChangedTo: string | null;
    /** 2+ lookups in a row found no channel for the creator's handle. */
    notFound: boolean;
  };
  declaredVsObserved: "match" | "mismatch" | "not_available";
  /** A fresh/stale observation with a follower count: the admin may decide on "observed" evidence. */
  observedUsable: boolean;
  /** The creator's own profile link (as saved on the account), when it is a web link. */
  profileUrl: string | null;
}

export interface TierReviewQuery {
  reason?: string;
  platform?: string;
  profileType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

const key = (profileType: string, profileId: string, id: string) =>
  `${profileType}|${profileId}|${id}`;
const iso = (d: unknown): string | null => {
  if (!d) return null;
  const t = new Date(d as string);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const time = (s: string | null) => (s ? new Date(s).getTime() : Infinity);

/** Every approved creator's tier review items, in queue order. */
export function buildTierReviewItems(input: TierReviewInput): TierReviewItem[] {
  const { asOf } = input;
  const verById = new Map(
    input.verifications.map((v) => [
      key(
        String(v.profileType),
        String(v.profileId),
        String(v.socialAccountId),
      ),
      v,
    ]),
  );
  const obsById = new Map(
    input.observations.map((o) => [
      key(
        String(o.profileType),
        String(o.profileId),
        String(o.socialAccountId),
      ),
      o,
    ]),
  );
  const connByProfile = new Map<string, TierReviewInput["connections"]>();
  for (const c of input.connections) {
    const k = `${c.userType}|${String(c.userId)}`;
    connByProfile.set(k, [...(connByProfile.get(k) || []), c]);
  }

  const items: TierReviewItem[] = [];
  for (const { profileType, profile } of input.creators) {
    if (profile?.isDeleted === true) continue;
    // Same population as ranking and the Matching Evidence page.
    if (
      !normalizeCreatorMatchInput(profile, profileType).eligibility
        .approvedActiveAccount
    )
      continue;
    const profileId = String(profile._id ?? "");
    const connected = connectedPlatformsFrom(
      connByProfile.get(`${profileType}|${profileId}`) || [],
    );
    for (const entry of Array.isArray(profile.socialMedia)
      ? profile.socialMedia
      : []) {
      const socialAccountId = String(entry?.socialAccountId ?? "");
      const declaredTier = String(entry?.tier ?? "").trim();
      if (!socialAccountId || !declaredTier) continue; // nothing to review

      const k = key(profileType, profileId, socialAccountId);
      const view = observationView(entry, obsById.get(k), connected);
      const tier = effectiveDecision("tier", verById.get(k)?.tier, entry);
      const cmp = buildSocialAccountComparison(
        entry,
        { tierVerification: tier },
        view,
      );
      const latest = cmp.observed.latest;
      const freshness = observationFreshness(latest?.capturedAt, asOf);
      const observedUsable =
        (freshness === "fresh" || freshness === "stale") &&
        latest?.observedFollowersCount != null;
      const declaredVsObserved = cmp.comparison.tier.declaredVsObserved;
      const state = verificationState(tier);
      const decidedAt = iso(tier.decidedAt);
      const capturedAt = iso(latest?.capturedAt);

      let reason: TierReviewReason | null = null;
      let since: string | null = null;
      if (state === "changed_since_review") {
        reason = "changed_since_review";
        since =
          iso(tier.invalidatedAt) ?? iso(tier.lastDecision?.decidedAt) ?? null;
      } else if (
        observedUsable &&
        declaredVsObserved === "mismatch" &&
        // A decision taken after this observation already weighed it.
        (state === "never_reviewed" || time(capturedAt) > time(decidedAt))
      ) {
        reason = "observed_mismatch";
        since = capturedAt;
      } else if (state === "never_reviewed") {
        reason = "never_reviewed";
        since = iso(profile.createdAt);
      }
      if (!reason) continue;

      items.push({
        reason,
        since,
        profileType,
        profileId,
        creatorName: String(profile.name ?? ""),
        username: String(profile.username ?? ""),
        socialAccountId,
        platform: cmp.platform,
        platformKey: cmp.platformKey,
        handle: cmp.declared.handle,
        declaredTier,
        declaredTierRef: cmp.comparison.tier.declared,
        decision: {
          status: tier.status,
          decidedTier:
            tier.decidedTier ?? tier.lastDecision?.decidedTier ?? null,
          decidedAt: decidedAt ?? iso(tier.lastDecision?.decidedAt),
          decidedByName:
            tier.decidedByName ?? tier.lastDecision?.decidedByName ?? null,
          evidenceBasis:
            tier.evidenceBasis ?? tier.lastDecision?.evidenceBasis ?? null,
          invalidatedAt: iso(tier.invalidatedAt),
        },
        observed: {
          followers: latest?.observedFollowersCount ?? null,
          tier: cmp.comparison.tier.observed,
          capturedAt,
          freshness,
          requiresConnection: cmp.observed.requiresConnection,
          connected: cmp.observed.connected,
          lastAttemptFailed: cmp.observed.lastAttempt?.status === "failed",
          externalUrl: webLink(latest?.externalUrl),
          handleChangedTo: renamedTo(obsById.get(k), entry),
          notFound: notFoundNow(obsById.get(k)),
        },
        declaredVsObserved,
        observedUsable,
        profileUrl: webLink(entry?.url),
      });
    }
  }

  const order = (r: TierReviewReason) => TIER_REVIEW_REASONS.indexOf(r);
  return items.sort(
    (a, b) =>
      order(a.reason) - order(b.reason) ||
      time(a.since) - time(b.since) ||
      a.profileId.localeCompare(b.profileId) ||
      a.socialAccountId.localeCompare(b.socialAccountId),
  );
}

/** The queue page for a query, plus counts (before filtering by reason) for the filter chips. */
const handleKey = (h: unknown) =>
  (typeof h === "string" ? h : "").trim().replace(/^@+/, "").toLowerCase();

/** The new handle when the channel was found by id under a different handle than the creator's. */
function renamedTo(doc: any, entry: any): string | null {
  const to =
    typeof doc?.handleChangedTo === "string" ? doc.handleChangedTo : "";
  return to && handleKey(to) !== handleKey(entry?.handle) ? to : null;
}

/** Same rule the creator sees (creator-observation.controller): 2+ "not found" in a row. */
function notFoundNow(doc: any): boolean {
  return (
    doc?.status === "failed" &&
    ["external_account_not_found", "account_mismatch"].includes(
      String(doc?.lastError),
    ) &&
    Number(doc?.failureCount || 0) >= 2
  );
}

/** An http(s) link as given, a bare "instagram.com/x" as https, anything else (javascript:, …) → null. */
function webLink(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function tierReviewQueue(
  input: TierReviewInput,
  query: TierReviewQuery,
) {
  const all = buildTierReviewItems(input);
  const platform = String(query.platform || "").toLowerCase();
  const profileType = String(query.profileType || "");
  const q = String(query.q || "")
    .trim()
    .toLowerCase();
  const scoped = all.filter(
    (i) =>
      (!platform || i.platformKey === platform) &&
      (!profileType || i.profileType === profileType) &&
      (!q ||
        i.creatorName.toLowerCase().includes(q) ||
        i.username.toLowerCase().includes(q) ||
        i.handle.toLowerCase().includes(q)),
  );
  const counts = Object.fromEntries(
    TIER_REVIEW_REASONS.map((r) => [
      r,
      scoped.filter((i) => i.reason === r).length,
    ]),
  ) as Record<TierReviewReason, number>;
  const platforms: Record<string, number> = {};
  for (const i of all)
    platforms[i.platformKey] = (platforms[i.platformKey] || 0) + 1;

  const reason = (TIER_REVIEW_REASONS as readonly string[]).includes(
    String(query.reason),
  )
    ? String(query.reason)
    : "";
  const filtered = reason ? scoped.filter((i) => i.reason === reason) : scoped;
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(query.pageSize) || 25)),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(
    totalPages,
    Math.max(1, Math.floor(Number(query.page) || 1)),
  );

  return {
    asOf: input.asOf.toISOString(),
    counts,
    total: scoped.length,
    platforms,
    filtered: filtered.length,
    page,
    pageSize,
    totalPages,
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
  };
}
