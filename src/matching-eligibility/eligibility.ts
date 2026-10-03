import {
  NormalizedCampaignMatchInput,
  NormalizedCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { CANONICAL_TIERS } from "../utils/tier-ranges.util";

/**
 * Stage 3B-2 — deterministic requirement eligibility (pure).
 *
 * creator + campaign (Stage 3B-1 normalized inputs) → PASS / FAIL / UNKNOWN per
 * explicit campaign requirement, each with a deterministic reason.
 *
 * Not a score: no weights, no ranking, no TrendScore, no history, no AI. Never
 * reads raw Mongo fields, never writes anything, never changes behaviour
 * elsewhere (open-campaign rules, alerts, search and invites are untouched).
 *
 * Status meanings:
 *   PASS    the requirement is met, or the campaign does not configure it.
 *   FAIL    the creator's stored data contradicts the requirement.
 *   UNKNOWN the requirement exists but cannot be checked (creator data
 *           missing, or the campaign value is not canonical / not supported) —
 *           missing data is never turned into a PASS.
 *
 * Overall: any FAIL → FAIL; else any UNKNOWN → UNKNOWN; else PASS.
 */

export type RequirementStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface RequirementResult {
  status: RequirementStatus;
  reason: string;
  configured: boolean;
  required?: unknown;
  actual?: unknown;
}

export interface EligibilityResult {
  campaignId: string;
  creatorId: string;
  creatorType: "Influencer" | "Photographer";
  overall: RequirementStatus;
  requirements: {
    accountApproval: RequirementResult;
    creatorType: RequirementResult;
    platformContent: RequirementResult;
    category: RequirementResult;
    minimumTier: RequirementResult;
    location: RequirementResult;
    language: RequirementResult;
  };
  /** Inputs deliberately NOT evaluated in Stage 3B-2, with why. */
  notEvaluated: Array<{ input: string; reason: string }>;
  /** Supporting evidence only — never part of PASS/FAIL. */
  evidence: {
    accountsOnCampaignPlatforms: Array<{
      platformKey: string | null;
      declaredTier: string | null;
      ownershipVerificationStatus: string;
      tierVerificationStatus: string;
      observationAvailable: boolean;
    }>;
  };
}

const pass = (
  reason: string,
  extra: Partial<RequirementResult> = {},
): RequirementResult => ({
  status: "PASS",
  reason,
  configured: true,
  ...extra,
});
const fail = (
  reason: string,
  extra: Partial<RequirementResult> = {},
): RequirementResult => ({
  status: "FAIL",
  reason,
  configured: true,
  ...extra,
});
const unknown = (
  reason: string,
  extra: Partial<RequirementResult> = {},
): RequirementResult => ({
  status: "UNKNOWN",
  reason,
  configured: true,
  ...extra,
});
const notConfigured = (reason: string): RequirementResult => ({
  status: "PASS",
  reason,
  configured: false,
});

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const intersect = (a: string[], b: string[]) => {
  const set = new Set(b.map(lower));
  return a.filter((x) => set.has(lower(x)));
};

const PHOTOGRAPHER_UNSUPPORTED =
  "Photographer-recipient campaigns store services in their platform/category fields; this requirement is not checkable in Stage 3B-2.";

const isPhotographerRecipient = (c: NormalizedCampaignMatchInput) =>
  c.recipientRole === "photographer";

// ── Account approval (shared rule from Stage 3B-1) ─────────────────────────

export function evaluateAccountApproval(
  creator: NormalizedCreatorMatchInput,
): RequirementResult {
  const e = creator.eligibility;
  const actual = {
    status: e.status,
    verificationStatus: e.verificationStatus,
    accountStatus: e.accountStatus,
    isDeleted: e.isDeleted,
  };
  // The decision itself is the shared approvedActiveAccount flag; the checks
  // below only choose the clearest explanation.
  if (e.approvedActiveAccount) {
    return pass("Creator is approved and active.", { actual });
  }
  let reason = "Creator is not approved and active.";
  if (e.isDeleted) reason = "Creator account is deleted.";
  else if (lower(e.accountStatus) === "suspended")
    reason = "Creator account is suspended.";
  else if (lower(e.status) !== "accepted")
    reason = `Creator account is not accepted (status: ${e.status || "none"}).`;
  else if (lower(e.verificationStatus) === "rejected")
    reason = "Creator approval status is rejected.";
  else if (!e.isEmailVerified || !e.isMobileVerified)
    reason = "Creator email or mobile number is not verified.";
  else if (
    !e.verifiedByTrendStarz &&
    lower(e.verificationStatus) !== "approved"
  )
    reason = `Creator is not approved yet (verification: ${e.verificationStatus || "none"}).`;
  return fail(reason, { actual });
}

// ── Creator type vs the campaign's recipient role ──────────────────────────

export function evaluateCreatorType(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  const wanted =
    campaign.recipientRole === "photographer" ? "Photographer" : "Influencer";
  return creator.profileType === wanted
    ? pass(`Campaign is for ${campaign.recipientRole}s.`, {
        required: wanted,
        actual: creator.profileType,
      })
    : fail(
        `Campaign is for ${campaign.recipientRole}s; this creator is a ${creator.profileType.toLowerCase()}.`,
        {
          required: wanted,
          actual: creator.profileType,
        },
      );
}

// ── Platform + content type ────────────────────────────────────────────────

/**
 * Semantics (existing): a campaign's enabled content types are the options a
 * creator CHOOSES ONE of when accepting (an invite stores a single
 * selectedPlatform + selectedContentType). So the creator must support AT
 * LEAST ONE enabled (platformKey, contentTypeKey) pair. Pairs are canonical
 * only — no name or fuzzy matching.
 */
export function evaluatePlatformContent(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  if (isPhotographerRecipient(campaign))
    return unknown(PHOTOGRAPHER_UNSUPPORTED);

  const required = campaign.contentTypes;
  const uncheckable = campaign.structuredDeliverables
    .filter((d) => !d.platformKey || !d.canonicalContentTypeKey)
    .map((d) => `${d.originalPlatform}/${d.originalContentType}`);

  if (required.length) {
    const matched = intersect(creator.contentTypes, required);
    if (matched.length) {
      return pass(`Creator supports ${matched.join(", ")}.`, {
        required,
        actual: creator.contentTypes,
      });
    }
    if (uncheckable.length) {
      return unknown(
        `Creator supports none of ${required.join(", ")}; other required options (${uncheckable.join(", ")}) have no canonical key to compare.`,
        { required, actual: creator.contentTypes },
      );
    }
    return fail(
      "Creator does not support any of the required platform/content combinations.",
      {
        required,
        actual: creator.contentTypes,
      },
    );
  }

  if (uncheckable.length) {
    return unknown(
      `Required content (${uncheckable.join(", ")}) has no canonical key to compare.`,
      {
        required: uncheckable,
      },
    );
  }

  // No content toggles: fall back to the campaign's platforms, if any.
  const platformKeys = campaign.platforms
    .map((p) => p.platformKey)
    .filter((k): k is string => !!k);
  const unknownPlatforms = campaign.platforms
    .filter((p) => !p.platformKey)
    .map((p) => p.original);
  if (!platformKeys.length && !unknownPlatforms.length) {
    return notConfigured("No platform/content requirement is configured.");
  }
  const onPlatform = intersect(creator.platforms, platformKeys);
  if (onPlatform.length) {
    return pass(`Creator has an account on ${onPlatform.join(", ")}.`, {
      required: platformKeys,
      actual: creator.platforms,
    });
  }
  if (unknownPlatforms.length) {
    return unknown(
      `Campaign platform(s) ${unknownPlatforms.join(", ")} are not canonical platforms.`,
      {
        required: campaign.platforms.map((p) => p.original),
        actual: creator.platforms,
      },
    );
  }
  return fail("Creator has no account on the required platforms.", {
    required: platformKeys,
    actual: creator.platforms,
  });
}

// ── Category ───────────────────────────────────────────────────────────────

/**
 * Brand campaigns: `categories` are the target creator categories.
 * Photographer-owned campaigns: `categories` are the OWNER's services; the
 * target influencer categories are the normalized targetCreatorCategories.
 */
export function evaluateCategory(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  if (isPhotographerRecipient(campaign))
    return unknown(PHOTOGRAPHER_UNSUPPORTED);
  const required =
    campaign.ownerType === "photographer"
      ? campaign.targetCreatorCategories
      : campaign.categories;
  if (!required.length)
    return notConfigured("No category requirement is configured.");
  if (!creator.categories.length) {
    return unknown("Creator category information is unavailable.", {
      required,
      actual: [],
    });
  }
  const matched = intersect(creator.categories, required);
  return matched.length
    ? pass(
        `Creator category matches the campaign category requirement (${matched.join(", ")}).`,
        {
          required,
          actual: creator.categories,
        },
      )
    : fail(
        "Creator categories do not match the campaign category requirement.",
        {
          required,
          actual: creator.categories,
        },
      );
}

// ── Minimum tier ───────────────────────────────────────────────────────────

const TIER_RANK = new Map(CANONICAL_TIERS.map((t, i) => [t.key, i]));

/**
 * "Minimum" = at least this tier, by canonical order (Stage 3A), on the
 * creator's accounts for the campaign's platforms (all accounts when the
 * campaign has no canonical platforms). Uses the DECLARED tier only — never
 * observed followers, never verification. Any account at/above → PASS; else
 * any account with an unreadable tier → UNKNOWN; else FAIL.
 */
export function evaluateMinimumTier(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  if (isPhotographerRecipient(campaign))
    return unknown(PHOTOGRAPHER_UNSUPPORTED);
  const min = campaign.minimumTier;
  if (!min) return notConfigured("No minimum tier requirement is configured.");
  const minRank = TIER_RANK.get(min.key) ?? -1;

  const platformKeys = campaign.platforms
    .map((p) => p.platformKey)
    .filter((k): k is string => !!k);
  const accounts = platformKeys.length
    ? creator.accounts.filter(
        (a) => a.platformKey && platformKeys.includes(a.platformKey),
      )
    : creator.accounts;
  if (!accounts.length) {
    return unknown(
      platformKeys.length
        ? `Creator has no account on ${platformKeys.join(", ")} to compare a tier.`
        : "Creator tier is not available for comparison.",
      { required: min.label },
    );
  }
  const known = accounts.filter((a) => a.declaredTier);
  const best = known.reduce<(typeof known)[number] | null>(
    (top, a) =>
      !top ||
      (TIER_RANK.get(a.declaredTier!.key) ?? -1) >
        (TIER_RANK.get(top.declaredTier!.key) ?? -1)
        ? a
        : top,
    null,
  );
  const actual = accounts.map(
    (a) =>
      `${a.platformKey ?? a.originalPlatform}: ${a.declaredTier?.label ?? (a.originalTier || "none")}`,
  );
  if (best && (TIER_RANK.get(best.declaredTier!.key) ?? -1) >= minRank) {
    return pass(
      `Creator tier ${best.declaredTier!.label} meets the minimum ${min.label} tier.`,
      { required: min.label, actual },
    );
  }
  if (known.length < accounts.length) {
    return unknown(
      "Creator tier is not available for comparison on every relevant account.",
      { required: min.label, actual },
    );
  }
  return fail(
    `Creator tier ${best!.declaredTier!.label} does not meet the minimum ${min.label} tier.`,
    {
      required: min.label,
      actual,
    },
  );
}

// ── Location (state, district — explicit values only) ──────────────────────

export function evaluateLocation(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  const reqState = campaign.location.state;
  const reqDistrict = campaign.location.district;
  if (!reqState && !reqDistrict)
    return notConfigured("No location requirement is configured.");

  const required = {
    state: reqState,
    district: reqDistrict,
    districtSource: campaign.location.districtSource,
  };
  const actual = {
    state: creator.location.state,
    district: creator.location.district,
  };
  const fails: string[] = [];
  const unknowns: string[] = [];
  const passes: string[] = [];

  if (reqState) {
    if (!creator.location.state) unknowns.push("Creator state is unavailable.");
    else if (lower(creator.location.state) !== lower(reqState))
      fails.push(
        `Campaign requires ${reqState}; creator is in ${creator.location.state}.`,
      );
    else passes.push(`state ${reqState}`);
  }
  // A district is only comparable within the required state: once the state
  // contradicts, the district adds nothing (and is not reported).
  if (reqDistrict && !fails.length) {
    if (!creator.location.district)
      unknowns.push("Creator district is unavailable.");
    else if (lower(creator.location.district) !== lower(reqDistrict))
      fails.push(
        `Campaign requires district ${reqDistrict}; creator is in ${creator.location.district}.`,
      );
    else passes.push(`district ${reqDistrict}`);
  }

  if (fails.length) return fail(fails.join(" "), { required, actual });
  if (unknowns.length) return unknown(unknowns.join(" "), { required, actual });
  return pass(`Creator location matches ${passes.join(" and ")}.`, {
    required,
    actual,
  });
}

// ── Language ───────────────────────────────────────────────────────────────

export function evaluateLanguage(
  creator: NormalizedCreatorMatchInput,
  campaign: NormalizedCampaignMatchInput,
): RequirementResult {
  if (isPhotographerRecipient(campaign) && campaign.languages.length)
    return unknown(PHOTOGRAPHER_UNSUPPORTED);
  const required = campaign.languages;
  if (!required.length)
    return notConfigured("No language requirement is configured.");
  // An empty creator language list means "not provided" (the field is optional) — UNKNOWN, not FAIL.
  if (!creator.languages.length) {
    return unknown("Creator language information is unavailable.", {
      required,
      actual: [],
    });
  }
  const matched = intersect(creator.languages, required);
  return matched.length
    ? pass(
        `Creator language matches the campaign language requirement (${matched.join(", ")}).`,
        {
          required,
          actual: creator.languages,
        },
      )
    : fail(
        "Creator languages do not match the campaign language requirement.",
        {
          required,
          actual: creator.languages,
        },
      );
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export function aggregateOverall(
  results: RequirementResult[],
): RequirementStatus {
  if (results.some((r) => r.status === "FAIL")) return "FAIL";
  if (results.some((r) => r.status === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

export const NOT_EVALUATED: EligibilityResult["notEvaluated"] = [
  {
    input: "followerRange",
    reason:
      "Campaign follower range is not read or enforced anywhere (Stage 3B-1); follower counts are not compared.",
  },
  {
    input: "budget",
    reason:
      "Campaign totals (paise / rupee totals) and creator per-deliverable rates (INR) are different units; no budget rule exists.",
  },
  {
    input: "availability",
    reason:
      "No campaign requirement uses creator availability; shown in the normalized input only.",
  },
  {
    input: "dates",
    reason:
      "No deterministic date requirement exists between creators and campaigns.",
  },
  {
    input: "verification / observation",
    reason:
      "Evidence only — campaigns have no verified-tier or observed-follower requirement.",
  },
];

export function evaluateEligibility(
  campaign: NormalizedCampaignMatchInput,
  creator: NormalizedCreatorMatchInput,
): EligibilityResult {
  const requirements = {
    accountApproval: evaluateAccountApproval(creator),
    creatorType: evaluateCreatorType(creator, campaign),
    platformContent: evaluatePlatformContent(creator, campaign),
    category: evaluateCategory(creator, campaign),
    minimumTier: evaluateMinimumTier(creator, campaign),
    location: evaluateLocation(creator, campaign),
    language: evaluateLanguage(creator, campaign),
  };
  const platformKeys = campaign.platforms
    .map((p) => p.platformKey)
    .filter((k): k is string => !!k);
  return {
    campaignId: campaign.campaignId,
    creatorId: creator.creatorId,
    creatorType: creator.profileType,
    overall: aggregateOverall(Object.values(requirements)),
    requirements,
    notEvaluated: NOT_EVALUATED.map((n) => ({ ...n })),
    evidence: {
      accountsOnCampaignPlatforms: creator.accounts
        .filter(
          (a) =>
            !platformKeys.length ||
            (a.platformKey && platformKeys.includes(a.platformKey)),
        )
        .map((a) => ({
          platformKey: a.platformKey,
          declaredTier: a.declaredTier?.label ?? null,
          ownershipVerificationStatus: a.evidence.ownershipVerificationStatus,
          tierVerificationStatus: a.evidence.tierVerificationStatus,
          observationAvailable: a.evidence.observationAvailable,
        })),
    },
  };
}
