import {
  ACTIVITY_BUCKET_ORDER,
  ActivityBucket,
  RankedCreator,
  activityBucket,
  rankEligibleCreators,
} from "../matching-eligibility/match-ranking";
import { evaluateEligibility } from "../matching-eligibility/eligibility";
import {
  NormalizedCreatorMatchInput,
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { PLATFORM_EVENT_COHORTS } from "../platform-events/platform-event-coverage";
import { connectedPlatformsFrom } from "../social-account-observation/platform-observers";
import { observationView } from "../social-account-observation/social-account-observation.service";
import { buildSocialAccountComparison } from "../social-account-comparison/social-account-comparison";
import { effectiveDecision } from "../social-account-verification/social-account-verification.service";
import { PROFILE_SELECTION_LIMITS } from "../utils/profile-selection-limits.util";
import { MINIMUM_RATE_RUPEES } from "../utils/social-account.util";

/**
 * Stage 3D-1m — matching EVIDENCE QUALITY measurement (pure, read-only).
 *
 * Measures how much trustworthy evidence exists for matching, per platform:
 * observation coverage/freshness, observed-vs-declared consistency,
 * verification coverage, rate/availability/activity/category data shape,
 * outcome-event coverage, and the resolution of the Stage 3C-1 ranking.
 *
 * Measurement only: never writes, never calls a platform, never changes
 * eligibility or ranking, and adds nothing to ranking. Every rule it relies on
 * is reused from the module that owns it (normalized inputs, eligibility,
 * rankEligibleCreators, effectiveDecision, observationView,
 * buildSocialAccountComparison, connectedPlatformsFrom) — nothing re-derived.
 *
 * `asOf` is the only clock. Same input + same asOf → identical report.
 */

export const MIN_SAMPLE_SIZE = 20;

/**
 * PROPOSED in Stage 3D-0 — not yet product decisions. Named here so the
 * baseline can be re-run unchanged once they are confirmed or adjusted.
 */
export const PROPOSED = {
  /** Observation is "fresh" up to this many days after capture… */
  observationFreshDays: 30,
  /** …"stale" up to this many; older is "expired" (counted as unknown evidence). */
  observationExpiredAfterDays: 90,
  /** Creator rates below this (INR per deliverable) are flagged; new saves are refused (3D-1d). */
  minimumRateRupees: MINIMUM_RATE_RUPEES,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Sample = "sufficient" | "insufficient";
const sample = (n: number): Sample =>
  n >= MIN_SAMPLE_SIZE ? "sufficient" : "insufficient";
const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((1000 * part) / whole) / 10 : null;
const inc = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] || 0) + 1;
};
const pairs = (n: number) => (n * (n - 1)) / 2;
/** ObjectId or string id → its hex/string form ("" when missing). */
const idText = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v && typeof (v as { toHexString?: unknown }).toHexString === "function"
      ? (v as { toHexString: () => string }).toHexString()
      : "";

// ── Input ──────────────────────────────────────────────────────────────────

export interface EvidenceQualityInput {
  asOf: Date;
  /** Non-deleted creator profiles (raw, as stored). */
  creators: Array<{
    profileType: "Influencer" | "Photographer";
    profile: Record<string, any>;
  }>;
  /** social_account_verifications docs (raw). */
  verifications: Array<Record<string, any>>;
  /** social_account_observations docs (raw). */
  observations: Array<Record<string, any>>;
  /** Usable Meta connections (not revoked, token present) — never the token itself. */
  connections: Array<{
    userId: unknown;
    userType: string;
    platform: string;
    instagramBusinessAccountId?: string | null;
  }>;
  /** Campaign docs (raw). */
  campaigns: Array<Record<string, any>>;
  /** platform_events rows (type, source, creator). */
  events: Array<{
    eventType: string;
    influencerId?: unknown;
    metadata?: { source?: string } | null;
  }>;
}

// ── Observation freshness ──────────────────────────────────────────────────

export type Freshness = "fresh" | "stale" | "expired" | "never";

/** Freshness of the latest SUCCESSFUL observation relative to asOf. Future/invalid capture → "never". */
export function observationFreshness(
  capturedAt: unknown,
  asOf: Date,
): Freshness {
  if (!capturedAt) return "never";
  const t = new Date(capturedAt as string).getTime();
  const elapsed = asOf.getTime() - t;
  if (!Number.isFinite(elapsed) || elapsed < 0) return "never";
  if (elapsed <= PROPOSED.observationFreshDays * DAY_MS) return "fresh";
  if (elapsed <= PROPOSED.observationExpiredAfterDays * DAY_MS) return "stale";
  return "expired";
}

// ── Per-account evidence (declared / verified / observed) ──────────────────

export interface PlatformEvidence {
  accounts: number;
  requiresConnection: number;
  connected: number;
  attempted: number;
  lastAttemptFailed: number;
  failureReasons: Record<string, number>;
  freshness: Record<Freshness, number>;
  /** Fresh or stale successful observation with a follower count. */
  usableObservedFollowers: number;
  usableObservedFollowersPct: number | null;
  handleConsistency: Record<"match" | "mismatch" | "not_available", number>;
  declaredVsObservedTier: Record<
    "match" | "mismatch" | "not_available",
    number
  >;
  ownership: Record<VerificationState, number>;
  tier: Record<VerificationState, number>;
  sample: Sample;
}

export type VerificationState =
  | "verified"
  | "rejected"
  | "never_reviewed"
  | "changed_since_review";

export function verificationState(
  view: ReturnType<typeof effectiveDecision>,
): VerificationState {
  if (view.status === "verified") return "verified";
  if (view.status === "rejected") return "rejected";
  return view.stale || view.invalidatedAt
    ? "changed_since_review"
    : "never_reviewed";
}

const emptyPlatform = (): PlatformEvidence => ({
  accounts: 0,
  requiresConnection: 0,
  connected: 0,
  attempted: 0,
  lastAttemptFailed: 0,
  failureReasons: {},
  freshness: { fresh: 0, stale: 0, expired: 0, never: 0 },
  usableObservedFollowers: 0,
  usableObservedFollowersPct: null,
  handleConsistency: { match: 0, mismatch: 0, not_available: 0 },
  declaredVsObservedTier: { match: 0, mismatch: 0, not_available: 0 },
  ownership: {
    verified: 0,
    rejected: 0,
    never_reviewed: 0,
    changed_since_review: 0,
  },
  tier: {
    verified: 0,
    rejected: 0,
    never_reviewed: 0,
    changed_since_review: 0,
  },
  sample: "insufficient",
});

const accountKey = (profileType: string, profileId: string, id: string) =>
  `${profileType}|${profileId}|${id}`;

export function measureSocialEvidence(
  creators: Array<{ profileType: string; profile: Record<string, any> }>,
  verifications: EvidenceQualityInput["verifications"],
  observations: EvidenceQualityInput["observations"],
  connections: EvidenceQualityInput["connections"],
  asOf: Date,
) {
  const verById = new Map(
    verifications.map((v) => [
      accountKey(
        String(v.profileType),
        String(v.profileId),
        String(v.socialAccountId),
      ),
      v,
    ]),
  );
  const obsById = new Map(
    observations.map((o) => [
      accountKey(
        String(o.profileType),
        String(o.profileId),
        String(o.socialAccountId),
      ),
      o,
    ]),
  );
  const connByProfile = new Map<string, typeof connections>();
  for (const c of connections) {
    const k = `${c.userType}|${String(c.userId)}`;
    connByProfile.set(k, [...(connByProfile.get(k) || []), c]);
  }

  const byPlatform: Record<string, PlatformEvidence> = {};
  for (const { profileType, profile } of creators) {
    const profileId = String(profile?._id ?? "");
    const connected = connectedPlatformsFrom(
      connByProfile.get(`${profileType}|${profileId}`) || [],
    );
    for (const entry of Array.isArray(profile?.socialMedia)
      ? profile.socialMedia
      : []) {
      const id = String(entry?.socialAccountId ?? "");
      const key = accountKey(profileType, profileId, id);
      const obsDoc = obsById.get(key);
      const view = observationView(entry, obsDoc, connected);
      const ver = verById.get(key);
      const ownership = effectiveDecision("ownership", ver?.ownership, entry);
      const tier = effectiveDecision("tier", ver?.tier, entry);
      const cmp = buildSocialAccountComparison(
        entry,
        { ownershipVerification: ownership, tierVerification: tier },
        view,
      );

      const p = (byPlatform[view.platformKey || "unknown"] ||= emptyPlatform());
      p.accounts++;
      if (view.requiresConnection) p.requiresConnection++;
      if (view.connected) p.connected++;
      if (view.observation) {
        p.attempted++;
        if (view.observation.status === "failed") {
          p.lastAttemptFailed++;
          inc(p.failureReasons, view.observation.lastError || "unknown");
        }
      }
      const fresh = observationFreshness(
        view.observation?.latest?.capturedAt,
        asOf,
      );
      p.freshness[fresh]++;
      if (
        (fresh === "fresh" || fresh === "stale") &&
        cmp.observed.latest?.observedFollowersCount != null
      )
        p.usableObservedFollowers++;
      p.handleConsistency[cmp.comparison.handle.status]++;
      p.declaredVsObservedTier[cmp.comparison.tier.declaredVsObserved]++;
      p.ownership[verificationState(ownership)]++;
      p.tier[verificationState(tier)]++;
    }
  }
  const overall = emptyPlatform();
  for (const p of Object.values(byPlatform)) {
    p.usableObservedFollowersPct = pct(p.usableObservedFollowers, p.accounts);
    p.sample = sample(p.accounts);
    overall.accounts += p.accounts;
    overall.requiresConnection += p.requiresConnection;
    overall.connected += p.connected;
    overall.attempted += p.attempted;
    overall.lastAttemptFailed += p.lastAttemptFailed;
    overall.usableObservedFollowers += p.usableObservedFollowers;
    for (const [k, v] of Object.entries(p.failureReasons))
      overall.failureReasons[k] = (overall.failureReasons[k] || 0) + v;
    for (const k of Object.keys(p.freshness) as Freshness[])
      overall.freshness[k] += p.freshness[k];
    for (const k of Object.keys(p.handleConsistency) as Array<
      keyof PlatformEvidence["handleConsistency"]
    >) {
      overall.handleConsistency[k] += p.handleConsistency[k];
      overall.declaredVsObservedTier[k] += p.declaredVsObservedTier[k];
    }
    for (const k of Object.keys(p.ownership) as VerificationState[]) {
      overall.ownership[k] += p.ownership[k];
      overall.tier[k] += p.tier[k];
    }
  }
  overall.usableObservedFollowersPct = pct(
    overall.usableObservedFollowers,
    overall.accounts,
  );
  overall.sample = sample(overall.accounts);
  return { byPlatform, overall };
}

// ── Creator-level data shape ───────────────────────────────────────────────

export function measureCreatorData(
  creators: NormalizedCreatorMatchInput[],
  asOf: Date,
) {
  const activity: Record<ActivityBucket, number> = {
    within_7_days: 0,
    within_8_30_days: 0,
    within_31_90_days: 0,
    over_90_days: 0,
    unknown: 0,
  };
  const categoryCounts: Record<string, number> = {};
  let categoriesOverCap = 0;
  let enabledRows = 0;
  let pricedRows = 0;
  let belowMinimum = 0;
  let multipleOf500 = 0;
  let confirmedRows = 0;
  let available = 0;
  let notAvailable = 0;
  let notSet = 0;
  const cap = PROFILE_SELECTION_LIMITS.influencer.categories;
  for (const c of creators) {
    activity[activityBucket(c.lastActiveAt, asOf).bucket]++;
    const n = c.categories.length;
    inc(categoryCounts, n > cap ? `${cap + 1}+` : String(n));
    if (c.profileType === "Influencer" && n > cap) categoriesOverCap++;
    for (const r of c.rates) {
      if (!r.enabled) continue;
      enabledRows++;
      if (r.priceRupees === null) continue;
      pricedRows++;
      if (r.priceRupees < PROPOSED.minimumRateRupees) belowMinimum++;
      if (r.priceRupees % 500 === 0) multipleOf500++;
      if (r.priceConfirmedAt) confirmedRows++;
    }
    // 3D-1d: an explicit "not available" is now stored; legacy "off" counts as not set.
    if (c.availability === true) available++;
    else if (c.availability === false) notAvailable++;
    else notSet++;
  }
  return {
    creators: creators.length,
    sample: sample(creators.length),
    activity,
    activityUnknownPct: pct(activity.unknown, creators.length),
    categories: {
      perCreator: categoryCounts,
      overCurrentCap: categoriesOverCap,
      cap,
    },
    rates: {
      enabledRows,
      pricedRows,
      belowProposedMinimum: belowMinimum,
      multipleOf500,
      multipleOf500Pct: pct(multipleOf500, pricedRows),
      /** 3D-1d: rates with a confirmation date (set or changed since tracking began). */
      confirmationTracked: true,
      confirmedRows,
      confirmedPct: pct(confirmedRows, pricedRows),
    },
    availability: {
      available,
      notAvailable,
      notSet,
      explicitStateTracked: true,
    },
  };
}

// ── Outcome-event coverage ─────────────────────────────────────────────────

export function measureOutcomes(
  events: EvidenceQualityInput["events"],
  approvedCreatorIds: Set<string>,
) {
  const byType: Record<
    string,
    { total: number; live: number; backfilled: number }
  > = {};
  const creators = new Set<string>();
  for (const e of events) {
    const t = (byType[String(e.eventType)] ||= {
      total: 0,
      live: 0,
      backfilled: 0,
    });
    t.total++;
    if (e.metadata?.source === "backfill") t.backfilled++;
    else t.live++;
    const id = idText(e.influencerId);
    if (id && approvedCreatorIds.has(id)) creators.add(id);
  }
  const live = Object.values(byType).reduce((a, t) => a + t.live, 0);
  return {
    total: events.length,
    live,
    backfilled: events.length - live,
    liveCaptureSince: Object.fromEntries(
      Object.entries(PLATFORM_EVENT_COHORTS).flatMap(([k, c]) => {
        // A cohort not yet deployed has no capture start to report.
        const start = c.deployedAt ?? c.observedFirstEventAt;
        return start ? [[k, start.toISOString()]] : [];
      }),
    ),
    byType,
    approvedCreatorsWithAnyEvent: creators.size,
    sample: sample(live),
  };
}

// ── Stage 3C-1 ranking resolution ──────────────────────────────────────────

const kPC = (r: RankedCreator) =>
  `${r.platformContent.matched.length}/${r.platformContent.total}`;
const kCAT = (r: RankedCreator) =>
  `${r.category.matched.length}/${r.category.total}`;
const kACT = (r: RankedCreator) =>
  String(ACTIVITY_BUCKET_ORDER[r.activity.bucket]);
/** The comparator's own keys, cumulatively (unknown activity shares the 31–90d key). */
const LAYER_KEYS: Array<[string, (r: RankedCreator) => string]> = [
  ["platformContent", (r) => kPC(r)],
  ["category", (r) => `${kPC(r)}|${kCAT(r)}`],
  ["activity", (r) => `${kPC(r)}|${kCAT(r)}|${kACT(r)}`],
];
const FINAL_KEY = LAYER_KEYS[2][1];

function groupSizes(
  ranked: RankedCreator[],
  key: (r: RankedCreator) => string,
) {
  const m = new Map<string, number>();
  for (const r of ranked) m.set(key(r), (m.get(key(r)) || 0) + 1);
  return [...m.values()];
}

/**
 * Pairwise view of the lexicographic order: of all pairs of ranked creators,
 * which layer first tells them apart. "creatorId" pairs are those the three
 * signals leave tied — their order is stable but not evidence-based.
 */
export function rankingResolution(ranked: RankedCreator[]) {
  const n = ranked.length;
  const total = pairs(n);
  const tiedAfter = LAYER_KEYS.map(([, key]) =>
    groupSizes(ranked, key).reduce((a, s) => a + pairs(s), 0),
  );
  const decidedPairs = {
    platformContent: total - tiedAfter[0],
    category: tiedAfter[0] - tiedAfter[1],
    activity: tiedAfter[1] - tiedAfter[2],
    creatorId: tiedAfter[2],
  };
  const finalSizes = groupSizes(ranked, FINAL_KEY);
  const multi = finalSizes.filter((s) => s > 1);
  const inTies = multi.reduce((a, b) => a + b, 0);
  const topNCutoffInTie: Record<string, boolean | null> = {};
  for (const top of [5, 10, 25]) {
    topNCutoffInTie[`top${top}`] =
      n > top ? FINAL_KEY(ranked[top - 1]) === FINAL_KEY(ranked[top]) : null;
  }
  return {
    ranked: n,
    distinctSignalCombinations: finalSizes.length,
    creatorsInTieGroups: inTies,
    creatorsInTieGroupsPct: pct(inTies, n),
    largestTieGroup: finalSizes.length ? Math.max(...finalSizes) : 0,
    totalPairs: total,
    decidedPairs,
    decidedPairsPct: Object.fromEntries(
      Object.entries(decidedPairs).map(([k, v]) => [k, pct(v, total)]),
    ) as Record<keyof typeof decidedPairs, number | null>,
    topNCutoffInTie,
  };
}

export function measureRankingResolution(
  campaigns: EvidenceQualityInput["campaigns"],
  creators: Array<{ profileType: string; input: NormalizedCreatorMatchInput }>,
  asOf: Date,
) {
  const rows = campaigns.map((raw) => {
    const campaign = normalizeCampaignMatchInput(raw);
    const role =
      campaign.recipientRole === "photographer" ? "Photographer" : "Influencer";
    const entries = creators
      .filter((c) => c.profileType === role)
      .map((c) => ({
        creator: c.input,
        result: evaluateEligibility(campaign, c.input),
      }));
    const ranked = rankEligibleCreators(campaign, entries, asOf);
    return {
      campaignId: campaign.campaignId,
      campaignNumber:
        typeof raw?.campaignNumber === "number" ? raw.campaignNumber : null,
      status: campaign.status,
      eligible: entries.filter((e) => e.result.overall === "PASS").length,
      ...rankingResolution(ranked),
    };
  });
  const totals = rows.reduce(
    (a, r) => {
      a.totalPairs += r.totalPairs;
      for (const k of Object.keys(a.decidedPairs) as Array<
        keyof typeof a.decidedPairs
      >)
        a.decidedPairs[k] += r.decidedPairs[k];
      a.ranked += r.ranked;
      a.creatorsInTieGroups += r.creatorsInTieGroups;
      return a;
    },
    {
      ranked: 0,
      creatorsInTieGroups: 0,
      totalPairs: 0,
      decidedPairs: {
        platformContent: 0,
        category: 0,
        activity: 0,
        creatorId: 0,
      },
    },
  );
  const cutoffs = (k: string) => ({
    inTie: rows.filter((r) => r.topNCutoffInTie[k] === true).length,
    measurable: rows.filter((r) => r.topNCutoffInTie[k] !== null).length,
  });
  return {
    campaigns: rows,
    overall: {
      campaigns: rows.length,
      ...totals,
      creatorsInTieGroupsPct: pct(totals.creatorsInTieGroups, totals.ranked),
      decidedPairsPct: Object.fromEntries(
        Object.entries(totals.decidedPairs).map(([k, v]) => [
          k,
          pct(v, totals.totalPairs),
        ]),
      ),
      topNCutoffInTie: {
        top5: cutoffs("top5"),
        top10: cutoffs("top10"),
        top25: cutoffs("top25"),
      },
    },
  };
}

// ── Report ─────────────────────────────────────────────────────────────────

export function buildEvidenceQualityReport(input: EvidenceQualityInput) {
  const { asOf } = input;
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))
    throw new Error("buildEvidenceQualityReport: asOf must be a valid Date");

  const creators = input.creators
    .filter((c) => c.profile?.isDeleted !== true)
    .map((c) => ({
      ...c,
      input: normalizeCreatorMatchInput(c.profile, c.profileType),
    }));
  // Evidence is measured on the population ranking actually sees.
  const approved = creators.filter(
    (c) => c.input.eligibility.approvedActiveAccount,
  );
  const population = (type: "Influencer" | "Photographer") => ({
    evaluated: creators.filter((c) => c.profileType === type).length,
    approvedActive: approved.filter((c) => c.profileType === type).length,
  });

  return {
    asOf: asOf.toISOString(),
    definitions: {
      population:
        "Approved, active, non-deleted creators (the population Stage 3C-1 ranking can rank). Ranking resolution evaluates every non-deleted creator of each campaign's recipient type, like the admin eligibility console.",
      minSampleSize: MIN_SAMPLE_SIZE,
      proposedThresholds: PROPOSED,
      thresholdStatus:
        "Proposed in Stage 3D-0 — pending product decision. Changing them changes this report, never ranking.",
      freshness:
        "fresh ≤ observationFreshDays, stale ≤ observationExpiredAfterDays, expired beyond (counts as unknown evidence), never = no successful observation.",
      tieGroups:
        "Creators with identical Stage 3C-1 ordering keys (unknown activity shares the 31–90 day key). Their relative order is stable but comes from the creator-ID tie-break, not marketplace evidence.",
    },
    population: {
      influencers: population("Influencer"),
      photographers: population("Photographer"),
    },
    socialEvidence: measureSocialEvidence(
      approved,
      input.verifications,
      input.observations,
      input.connections,
      asOf,
    ),
    creatorData: {
      influencers: measureCreatorData(
        approved
          .filter((c) => c.profileType === "Influencer")
          .map((c) => c.input),
        asOf,
      ),
      photographers: measureCreatorData(
        approved
          .filter((c) => c.profileType === "Photographer")
          .map((c) => c.input),
        asOf,
      ),
    },
    outcomes: measureOutcomes(
      input.events,
      new Set(approved.map((c) => c.input.creatorId)),
    ),
    rankingResolution: measureRankingResolution(
      input.campaigns,
      creators,
      asOf,
    ),
  };
}

export type EvidenceQualityReport = ReturnType<
  typeof buildEvidenceQualityReport
>;
