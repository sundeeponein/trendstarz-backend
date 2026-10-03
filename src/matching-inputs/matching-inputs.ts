import { normalizeContentType } from "../utils/content-type.util";
import {
  isApprovedActiveAccount,
  isDiscoverableProfile,
} from "../utils/profile-eligibility.util";
import {
  canonicalPlatformKey,
  isSocialAccountId,
} from "../utils/social-account.util";
import { resolveTier } from "../utils/tier-ranges.util";

/**
 * Stage 3B-1 — normalized MATCHING INPUTS (read model only).
 *
 * Pure, deterministic, side-effect free: builds a structured view of a creator
 * or a campaign from data that already exists. Original values are kept next
 * to every canonical value. No scores, no weights, no matching, no history
 * metrics (Stage 3B-0: not ready), no TrendScore (a ranking signal, kept
 * separate), and nothing is ever written back.
 */

export interface TierRef {
  key: string;
  label: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function uniqueStrings(values: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const v = text(raw);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

function tierRef(raw: unknown): TierRef | null {
  const t = resolveTier(raw);
  return t ? { key: t.key, label: t.label } : null;
}

function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One deliverable: platform + content type (original and canonical) + price in RUPEES per deliverable. */
export interface NormalizedDeliverable {
  platformKey: string | null;
  originalPlatform: string;
  originalContentType: string;
  canonicalContentTypeKey: string | null;
  enabled: boolean;
  /** INR rupees per deliverable; null when unpriced. */
  priceRupees: number | null;
}

function deliverablesOf(socialMedia: unknown): NormalizedDeliverable[] {
  const rows: NormalizedDeliverable[] = [];
  for (const sm of Array.isArray(socialMedia) ? socialMedia : []) {
    const platform = sm?.platformKey || sm?.platform;
    for (const ct of Array.isArray(sm?.contentTypes) ? sm.contentTypes : []) {
      const n = normalizeContentType(platform, ct?.name);
      rows.push({
        ...n,
        originalPlatform: text(sm?.platform),
        enabled: ct?.enabled === true,
        priceRupees: positiveNumber(ct?.price),
      });
    }
  }
  return rows;
}

/** Canonical "platformKey:contentTypeKey" pairs (only fully canonical ones). */
function contentPairs(rows: NormalizedDeliverable[]): string[] {
  return [
    ...new Set(
      rows
        .filter((r) => r.platformKey && r.canonicalContentTypeKey)
        .map((r) => `${r.platformKey}:${r.canonicalContentTypeKey}`),
    ),
  ];
}

// ── Creator ────────────────────────────────────────────────────────────────

export interface CreatorAccountEvidence {
  ownershipVerificationStatus: "pending" | "verified" | "rejected";
  tierVerificationStatus: "pending" | "verified" | "rejected";
  observationAvailable: boolean;
  observedFollowersAvailable: boolean;
}

export interface NormalizedCreatorAccount {
  socialAccountId: string | null;
  platformKey: string | null;
  originalPlatform: string;
  handle: string;
  declaredTier: TierRef | null;
  originalTier: string;
  /** Evidence only — never a weight, never a filter here. */
  evidence: CreatorAccountEvidence;
}

export interface NormalizedCreatorMatchInput {
  creatorId: string;
  profileType: "Influencer" | "Photographer";
  eligibility: {
    /** Shared approval rule (profile-eligibility.util): accepted, not deleted/suspended, email+mobile verified, admin approved. */
    approvedActiveAccount: boolean;
    /** Search discoverability for a logged-in viewer (adds visibility, photo, state, social tier). */
    discoverable: boolean;
    status: string;
    verificationStatus: string;
    accountStatus: string;
    isDeleted: boolean;
  };
  accounts: NormalizedCreatorAccount[];
  platforms: string[];
  categories: string[];
  /** Canonical "platformKey:contentTypeKey" the creator offers (enabled). */
  contentTypes: string[];
  /** Per-deliverable rates, INR rupees. */
  rates: NormalizedDeliverable[];
  /** Explicitly stored location only — nothing inferred. No city/country is collected. */
  location: { state: string | null; district: string | null };
  languages: string[];
  availability: boolean | null;
  lastActiveAt: Date | null;
}

export interface EvidenceByAccount {
  verification?: Map<string, { ownership?: string; tier?: string }>;
  observation?: Map<
    string,
    { available: boolean; followersAvailable: boolean }
  >;
}

const decision = (v: unknown): "pending" | "verified" | "rejected" =>
  v === "verified" || v === "rejected" ? v : "pending";

export function normalizeCreatorMatchInput(
  profile: Record<string, any>,
  profileType: "Influencer" | "Photographer",
  evidence: EvidenceByAccount = {},
): NormalizedCreatorMatchInput {
  const socialMedia = Array.isArray(profile?.socialMedia)
    ? profile.socialMedia
    : [];

  const accounts: NormalizedCreatorAccount[] = socialMedia.map((sm: any) => {
    const id = isSocialAccountId(sm?.socialAccountId)
      ? String(sm.socialAccountId)
      : null;
    const v = id ? evidence.verification?.get(id) : undefined;
    const o = id ? evidence.observation?.get(id) : undefined;
    return {
      socialAccountId: id,
      platformKey: canonicalPlatformKey(sm?.platformKey || sm?.platform),
      originalPlatform: text(sm?.platform),
      handle: text(sm?.handle),
      declaredTier: tierRef(sm?.tier),
      originalTier: text(sm?.tier),
      evidence: {
        ownershipVerificationStatus: decision(v?.ownership),
        tierVerificationStatus: decision(v?.tier),
        observationAvailable: !!o?.available,
        observedFollowersAvailable: !!o?.followersAvailable,
      },
    };
  });

  const rates = deliverablesOf(socialMedia);
  const lastActive = profile?.lastLoginAt || profile?.lastOpenedAt || null;
  const availability = profile?.collaborationAvailability?.enabled;

  return {
    creatorId: String(profile?._id ?? ""),
    profileType,
    eligibility: {
      approvedActiveAccount: isApprovedActiveAccount(profile),
      discoverable: isDiscoverableProfile(profile, {
        photoField: "profileImages",
        viewerIsAuthenticated: true,
        requireSocialTier: profileType === "Influencer",
      }),
      status: text(profile?.status),
      verificationStatus: text(profile?.verificationStatus),
      accountStatus: text(profile?.accountStatus),
      isDeleted: profile?.isDeleted === true,
    },
    accounts,
    platforms: [
      ...new Set(
        accounts.map((a) => a.platformKey).filter((k): k is string => !!k),
      ),
    ],
    // Photographers use skills[] as their category list.
    categories: uniqueStrings(
      profileType === "Photographer" ? profile?.skills : profile?.categories,
    ),
    contentTypes: contentPairs(rates.filter((r) => r.enabled)),
    rates,
    location: {
      state: text(profile?.location?.state) || null,
      district: text(profile?.location?.district) || null,
    },
    languages: uniqueStrings(profile?.languages),
    availability: typeof availability === "boolean" ? availability : null,
    lastActiveAt: lastActive ? new Date(lastActive) : null,
  };
}

// ── Campaign ───────────────────────────────────────────────────────────────

export interface NormalizedCampaignMatchInput {
  campaignId: string;
  status: string;
  campaignMode: string;
  campaignType: string;
  recipientRole: "influencer" | "photographer";
  platforms: { platformKey: string | null; original: string }[];
  categories: string[];
  /** Canonical "platformKey:contentTypeKey" the campaign asks for (enabled toggles). */
  contentTypes: string[];
  /** Structured deliverables = the campaign's enabled content-type toggles. Free text is NOT used. */
  structuredDeliverables: NormalizedDeliverable[];
  /** Free-text deliverables kept for display/debugging only. */
  freeTextDeliverables: string[];
  minimumTier: TierRef | null;
  targetTiers: TierRef[];
  /**
   * Photographer-owned campaigns store target influencer categories in
   * `targetTiers` (campaign-form reuse); surfaced here instead of as tiers.
   */
  targetCreatorCategories: string[];
  /**
   * Explicitly stored target only (photographer campaigns fall back to the
   * venue). Since Stage 3B-1 (T1) the form saves the district to
   * targetDistrict; campaigns saved before that only have it in
   * targetCities[0] (legacy fallback). districtSource says which was used.
   */
  location: {
    state: string | null;
    district: string | null;
    districtSource: "targetDistrict" | "venueDistrict" | "targetCities" | null;
    cities: string[];
  };
  languages: string[];
  budget: {
    /** Per-deliverable prices are on structuredDeliverables (INR rupees) — comparable with creator rates. */
    perDeliverableCurrency: "INR";
    /** Total/per-creator amounts are NOT per deliverable — not comparable with rates. */
    pricePerCreatorPaise: number | null;
    estimatedTotalPaise: number | null;
    budgetMinRupees: number | null;
    budgetMaxRupees: number | null;
  };
  dates: {
    start: Date | null;
    end: Date | null;
    acceptanceDeadline: Date | null;
  };
  /**
   * Schema fields that nothing reads or enforces (only an unused photographer
   * collaboration form ever wrote minFollowerCount). Reported, never used.
   */
  followerRange: { min: number | null; max: number | null; enforced: false };
}

const dateOrNull = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function normalizeCampaignMatchInput(
  campaign: Record<string, any>,
): NormalizedCampaignMatchInput {
  const recipientRole =
    text(campaign?.inviteRecipientRole) === "photographer"
      ? "photographer"
      : "influencer";
  const structuredDeliverables = deliverablesOf(campaign?.socialMedia).filter(
    (d) => d.enabled,
  );
  const isPhotographer = recipientRole === "photographer";
  const photographerOwned = text(campaign?.ownerType) === "photographer";
  const targetTiers: TierRef[] = [];
  for (const t of photographerOwned
    ? []
    : Array.isArray(campaign?.targetTiers)
      ? campaign.targetTiers
      : []) {
    const ref = tierRef(t);
    if (ref && !targetTiers.some((x) => x.key === ref.key))
      targetTiers.push(ref);
  }
  const cities = uniqueStrings(campaign?.targetCities);
  const venueDistrict = isPhotographer ? text(campaign?.venueDistrict) : "";
  const targetDistrict = text(campaign?.targetDistrict);
  const district =
    venueDistrict || targetDistrict || (cities.length === 1 ? cities[0] : "");
  const districtSource = venueDistrict
    ? ("venueDistrict" as const)
    : targetDistrict
      ? ("targetDistrict" as const)
      : district
        ? ("targetCities" as const)
        : null;

  return {
    campaignId: String(campaign?._id ?? ""),
    status: text(campaign?.status),
    campaignMode: text(campaign?.campaignMode),
    campaignType: text(campaign?.campaignType),
    recipientRole,
    platforms: uniqueStrings(campaign?.platforms).map((p) => ({
      platformKey: canonicalPlatformKey(p),
      original: p,
    })),
    categories: uniqueStrings(campaign?.categories),
    contentTypes: contentPairs(structuredDeliverables),
    structuredDeliverables,
    freeTextDeliverables: uniqueStrings(campaign?.deliverables),
    minimumTier: tierRef(campaign?.minInfluencerTier),
    targetTiers,
    targetCreatorCategories: photographerOwned
      ? uniqueStrings(campaign?.targetTiers)
      : [],
    location: {
      state:
        text(
          isPhotographer
            ? campaign?.venueState || campaign?.targetState
            : campaign?.targetState,
        ) || null,
      district: district || null,
      districtSource,
      cities,
    },
    languages: uniqueStrings(campaign?.languages),
    budget: {
      perDeliverableCurrency: "INR",
      pricePerCreatorPaise: positiveNumber(campaign?.pricePerInfluencer),
      estimatedTotalPaise: positiveNumber(campaign?.estimatedBudget),
      budgetMinRupees: positiveNumber(campaign?.budgetMin),
      budgetMaxRupees: positiveNumber(campaign?.budgetMax),
    },
    dates: {
      start: dateOrNull(campaign?.startDate || campaign?.timelineStart),
      end: dateOrNull(campaign?.endDate || campaign?.timelineEnd),
      acceptanceDeadline: dateOrNull(campaign?.acceptanceDeadline),
    },
    followerRange: {
      min: positiveNumber(campaign?.minFollowerCount),
      max: positiveNumber(campaign?.maxFollowerCount),
      enforced: false,
    },
  };
}
