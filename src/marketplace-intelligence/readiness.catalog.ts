/**
 * Stage 3B-0 — Marketplace Intelligence Readiness: the STATIC half of the audit.
 *
 * Every entry below was checked against the code (schemas, services, search,
 * eligibility, invitations) when this stage was written. The live half — how
 * many records actually carry each signal, which spellings exist, which events
 * were recorded — is measured at request time (readiness.analysis.ts).
 *
 * Nothing here scores, ranks or matches. "safeForMatching" is a statement about
 * data trustworthiness for a FUTURE deterministic matcher, not a weight.
 */

export const SIGNAL_CATEGORIES = [
  "IDENTITY",
  "PLATFORM",
  "AUDIENCE",
  "CONTENT",
  "CATEGORY",
  "GEOGRAPHY",
  "LANGUAGE",
  "AVAILABILITY",
  "PERFORMANCE",
  "RELIABILITY",
  "COLLABORATION_HISTORY",
  "CAMPAIGN_REQUIREMENTS",
  "BRAND_REQUIREMENTS",
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

/** AVAILABLE ≥ 80% of records · PARTIAL 20–80% · MISSING < 20% — unless overridden by a known reliability problem. */
export type Availability =
  | "AVAILABLE"
  | "PARTIAL"
  | "MISSING"
  | "UNRELIABLE"
  | "DERIVED";

export type SignalType =
  | "id"
  | "categorical"
  | "multi_categorical"
  | "numeric"
  | "boolean"
  | "timestamp"
  | "free_text"
  | "rate";

export type SafeForMatching = "yes" | "with_caveat" | "no";

/** How a signal's live coverage is measured (see readiness.analysis.ts). */
export interface CoverageRef {
  entity:
    | "influencer"
    | "photographer"
    | "brand"
    | "campaign"
    | "socialAccount";
  /** Field key in the measured coverage table. */
  field: string;
}

export interface SignalDefinition {
  signal: string;
  category: SignalCategory;
  source: string;
  type: SignalType;
  nullable: boolean;
  derived: boolean;
  /** Where the platform uses it TODAY (empty = stored but unused). */
  currentUsage: string[];
  safeForMatching: SafeForMatching;
  notes: string;
  coverage?: CoverageRef;
  /** Fixed availability, for signals whose coverage % would be misleading. */
  availabilityOverride?: Availability;
  /** Priority for a first deterministic matcher. */
  priority: "critical" | "important" | "optional";
}

export const CREATOR_SIGNALS: SignalDefinition[] = [
  // ── IDENTITY ──
  {
    signal: "creator.id",
    category: "IDENTITY",
    source: "influencers._id",
    type: "id",
    nullable: false,
    derived: false,
    currentUsage: ["search", "eligibility", "invitations"],
    safeForMatching: "yes",
    notes:
      "Stable Mongo id. Photographers are a separate collection with their own id space.",
    availabilityOverride: "AVAILABLE",
    priority: "critical",
  },
  {
    signal: "creator.approval",
    category: "IDENTITY",
    source: "influencers.status / verificationStatus / verifiedByTrendStarz",
    type: "categorical",
    nullable: false,
    derived: false,
    currentUsage: ["search_eligibility", "campaign_eligibility"],
    safeForMatching: "yes",
    notes:
      "A gate, not a gap: only approved creators are matchable. Search requires status 'accepted' + (verificationStatus 'approved' OR verifiedByTrendStarz) + email & mobile verified + photo + state. The campaign-alert matcher (notifyMatchingInfluencers) does NOT check approval — it only requires verified email/mobile. coverage = approved profiles.",
    coverage: { entity: "influencer", field: "approvedProfiles" },
    availabilityOverride: "AVAILABLE",
    priority: "critical",
  },
  // ── PLATFORM ──
  {
    signal: "creator.socialAccounts.platform",
    category: "PLATFORM",
    source: "influencers.socialMedia[].platform (+ platformKey since 3A-0)",
    type: "multi_categorical",
    nullable: false,
    derived: false,
    currentUsage: [
      "search_display",
      "campaign_eligibility (tier per platform)",
      "campaign_alerts",
    ],
    safeForMatching: "yes",
    notes:
      'Display names ("Instagram", "X / Twitter"). Use platformKey (3A-0) for matching — display names differ in spelling from campaign platforms in principle.',
    coverage: { entity: "influencer", field: "socialMediaAccounts" },
    priority: "critical",
  },
  {
    signal: "creator.socialAccounts.socialAccountId",
    category: "PLATFORM",
    source: "influencers.socialMedia[].socialAccountId",
    type: "id",
    nullable: false,
    derived: false,
    currentUsage: [
      "admin verification",
      "admin observation",
      "admin comparison",
    ],
    safeForMatching: "yes",
    notes:
      "Stable per-account identity (3A-0). Joins DECLARED, VERIFIED and OBSERVED.",
    coverage: { entity: "socialAccount", field: "socialAccountId" },
    priority: "important",
  },
  {
    signal: "creator.socialAccounts.handle",
    category: "PLATFORM",
    source: "influencers.socialMedia[].handle",
    type: "free_text",
    nullable: true,
    derived: false,
    currentUsage: ["search_display", "search_eligibility"],
    safeForMatching: "with_caveat",
    notes:
      "Creator-declared. Ownership is only established by a 3A-1 admin decision.",
    coverage: { entity: "influencer", field: "socialHandle" },
    priority: "important",
  },
  // ── AUDIENCE ──
  {
    signal: "creator.declaredTier",
    category: "AUDIENCE",
    source: "influencers.socialMedia[].tier",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: [
      "search_filter (client-side)",
      "campaign_eligibility (tier_filtered_open)",
      "campaign_alerts",
    ],
    safeForMatching: "with_caveat",
    notes:
      "DECLARED by the creator. Canonical labels (3A-0 CANONICAL_TIERS). Not evidence of audience size until VERIFIED or matched by an OBSERVATION.",
    coverage: { entity: "influencer", field: "socialTier" },
    priority: "critical",
  },
  {
    signal: "creator.verifiedTier",
    category: "AUDIENCE",
    source: "social_account_verifications.tier (status 'verified')",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: ["admin"],
    safeForMatching: "yes",
    notes:
      "Explicit admin decision tied to a snapshot of the declared tier (3A-1).",
    coverage: { entity: "socialAccount", field: "tierVerified" },
    priority: "important",
  },
  {
    signal: "creator.ownershipVerified",
    category: "AUDIENCE",
    source: "social_account_verifications.ownership (status 'verified')",
    type: "boolean",
    nullable: true,
    derived: false,
    currentUsage: ["admin"],
    safeForMatching: "yes",
    notes: "Explicit admin decision tied to the reviewed handle (3A-1).",
    coverage: { entity: "socialAccount", field: "ownershipVerified" },
    priority: "important",
  },
  {
    signal: "creator.followersCount",
    category: "AUDIENCE",
    source: "influencers.socialMedia[].followersCount",
    type: "numeric",
    nullable: true,
    derived: false,
    currentUsage: [
      "search_ranking (tiebreak)",
      "search_eligibility (tier OR followers > 0)",
    ],
    safeForMatching: "no",
    notes:
      "Server-owned since 3A-0 and never written: every entry is 0, so the ranking tiebreak that uses it is inert. Do not use; use observed followers instead.",
    availabilityOverride: "UNRELIABLE",
    priority: "optional",
  },
  {
    signal: "creator.observedFollowers",
    category: "AUDIENCE",
    source:
      "social_account_observations.observedFollowersCount (latest success)",
    type: "numeric",
    nullable: true,
    derived: false,
    currentUsage: ["admin observation", "admin comparison"],
    safeForMatching: "with_caveat",
    notes:
      "OBSERVED. YouTube works with the API key; Instagram/Facebook only once a creator connects (Meta App Review pending). Admin-triggered only, so coverage grows slowly.",
    coverage: { entity: "socialAccount", field: "observed" },
    priority: "important",
  },
  {
    signal: "creator.selfReportedStats",
    category: "AUDIENCE",
    source: "influencers.socialMedia[].selfReportedStats",
    type: "numeric",
    nullable: true,
    derived: false,
    currentUsage: ["TrendScore (self-reported fallback)"],
    safeForMatching: "no",
    notes: "DECLARED engagement numbers, unverified.",
    coverage: { entity: "influencer", field: "selfReportedEngagement" },
    priority: "optional",
  },
  // ── CONTENT ──
  {
    signal: "creator.contentTypes",
    category: "CONTENT",
    source: "influencers.socialMedia[].contentTypes[] (name, enabled, price)",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: [
      "profile/search display",
      "invitations (selectedContentType, offered amount)",
    ],
    safeForMatching: "with_caveat",
    notes:
      "Names are per-platform master options (Instagram 'Photo post', Facebook 'Post', X 'Tweet / post'). Consistent within a platform, but there is no cross-platform content-type key, so matching across platforms needs a mapping.",
    coverage: { entity: "influencer", field: "pricedContentTypes" },
    priority: "critical",
  },
  // ── CATEGORY ──
  {
    signal: "creator.categories",
    category: "CATEGORY",
    source: "influencers.categories[]",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: [
      "search_filter (server-side)",
      "campaign_alerts (categories $in)",
    ],
    safeForMatching: "yes",
    notes: "Chosen from the categories master list.",
    coverage: { entity: "influencer", field: "categories" },
    priority: "critical",
  },
  {
    signal: "creator.influencerCategory",
    category: "CATEGORY",
    source: "influencers.influencerCategory",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: [],
    safeForMatching: "no",
    notes:
      "Legacy single-category field, mostly empty; superseded by categories[].",
    coverage: { entity: "influencer", field: "influencerCategory" },
    priority: "optional",
  },
  {
    signal: "creator.creatorTypes",
    category: "CATEGORY",
    source: "influencers.creatorTypes[]",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: ["search_filter (creatorType)"],
    safeForMatching: "with_caveat",
    notes: "Optional profile field.",
    coverage: { entity: "influencer", field: "creatorTypes" },
    priority: "optional",
  },
  // ── GEOGRAPHY ──
  {
    signal: "creator.location.state",
    category: "GEOGRAPHY",
    source: "influencers.location.state",
    type: "categorical",
    nullable: false,
    derived: false,
    currentUsage: [
      "search_eligibility (required)",
      "search_ranking (location priority)",
      "search_filter",
      "campaign_eligibility",
      "campaign_alerts",
    ],
    safeForMatching: "yes",
    notes: "Required for Search. Chosen from the states master list.",
    coverage: { entity: "influencer", field: "locationState" },
    priority: "critical",
  },
  {
    signal: "creator.location.district",
    category: "GEOGRAPHY",
    source: "influencers.location.district",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: [
      "search_ranking (location priority)",
      "search_filter",
      "campaign_eligibility",
      "campaign_alerts",
    ],
    safeForMatching: "yes",
    notes:
      "Campaign eligibility lets a creator WITHOUT a district through a district-targeted campaign (missing = no conflict).",
    coverage: { entity: "influencer", field: "locationDistrict" },
    priority: "important",
  },
  {
    signal: "creator.location.country",
    category: "GEOGRAPHY",
    source: "influencers.location.country",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: [
      "search_ranking (falls back to DISCOVERY_DEFAULT_COUNTRY = india)",
    ],
    safeForMatching: "no",
    notes: "Not collected; ranking assumes India.",
    availabilityOverride: "MISSING",
    priority: "optional",
  },
  // ── LANGUAGE ──
  {
    signal: "creator.languages",
    category: "LANGUAGE",
    source: "influencers.languages[]",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: ["profile display"],
    safeForMatching: "yes",
    notes:
      "Chosen from the languages master list, but NOT used by search, eligibility or alerts, and campaigns have no language requirement to match against.",
    coverage: { entity: "influencer", field: "languages" },
    priority: "important",
  },
  // ── AVAILABILITY ──
  {
    signal: "creator.collaborationAvailability",
    category: "AVAILABILITY",
    source: "influencers.collaborationAvailability.enabled",
    type: "boolean",
    nullable: true,
    derived: false,
    currentUsage: ["profile display"],
    safeForMatching: "with_caveat",
    notes: "Creator-set flag; not consulted by search, eligibility or alerts.",
    coverage: { entity: "influencer", field: "collaborationAvailability" },
    priority: "important",
  },
  {
    signal: "creator.lastActiveAt",
    category: "AVAILABILITY",
    source: "influencers.lastLoginAt (fallback lastOpenedAt / updatedAt)",
    type: "timestamp",
    nullable: true,
    derived: false,
    currentUsage: ["search_ranking (activity tiebreak)"],
    safeForMatching: "with_caveat",
    notes:
      "Login time, not responsiveness. Freshness is reported in creatorActivity.",
    coverage: { entity: "influencer", field: "lastLoginAt" },
    priority: "important",
  },
  // ── PERFORMANCE ──
  {
    signal: "creator.trendScore",
    category: "PERFORMANCE",
    source:
      "collaboration_audits (isCurrent).collaborationScore / campaignReadiness / trendstarzRecommended",
    type: "numeric",
    nullable: true,
    derived: true,
    currentUsage: [
      "search_display",
      "brand TrendScore sort & filter (client-side, loaded batch)",
      "search 'TrendStarz Recommended' sort",
    ],
    safeForMatching: "with_caveat",
    notes:
      "Rules-based score, largely from profile completeness and self-reported data unless platforms are connected. Not part of server-side ranking.",
    coverage: { entity: "influencer", field: "trendScore" },
    priority: "important",
  },
  {
    signal: "creator.reviews",
    category: "PERFORMANCE",
    source: "reviews",
    type: "numeric",
    nullable: true,
    derived: false,
    currentUsage: ["profile display"],
    safeForMatching: "no",
    notes: "Too few reviews to use.",
    availabilityOverride: "MISSING",
    priority: "optional",
  },
  // ── RELIABILITY / COLLABORATION_HISTORY (derived — readiness in derivedMetricReadiness) ──
  {
    signal: "creator.acceptanceRate",
    category: "RELIABILITY",
    source: "platform_events (creator_invited → invite_accepted)",
    type: "rate",
    nullable: true,
    derived: true,
    currentUsage: [],
    safeForMatching: "no",
    notes: "See derivedMetricReadiness.",
    availabilityOverride: "DERIVED",
    priority: "optional",
  },
  {
    signal: "creator.completionRate",
    category: "COLLABORATION_HISTORY",
    source:
      "platform_events (invite_accepted → content_approved / payment_completed)",
    type: "rate",
    nullable: true,
    derived: true,
    currentUsage: ["admin metrics (Stage 2B, platform-wide)"],
    safeForMatching: "no",
    notes: "See derivedMetricReadiness.",
    availabilityOverride: "DERIVED",
    priority: "optional",
  },
];

export const BRAND_SIGNALS: SignalDefinition[] = [
  {
    signal: "brand.categories",
    category: "BRAND_REQUIREMENTS",
    source: "brands.categories[]",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: ["search_filter (brand tab)"],
    safeForMatching: "yes",
    notes: "Industry. Campaign categories are the better matching input.",
    coverage: { entity: "brand", field: "categories" },
    priority: "optional",
  },
  {
    signal: "brand.languages",
    category: "BRAND_REQUIREMENTS",
    source: "brands.languages[]",
    type: "multi_categorical",
    nullable: true,
    derived: false,
    currentUsage: [],
    safeForMatching: "with_caveat",
    notes:
      "The only stored language preference on the brand side (campaigns have none).",
    coverage: { entity: "brand", field: "languages" },
    priority: "optional",
  },
  {
    signal: "brand.location",
    category: "BRAND_REQUIREMENTS",
    source: "brands.location.state / district",
    type: "categorical",
    nullable: true,
    derived: false,
    currentUsage: ["creator search ranking (viewer location priority)"],
    safeForMatching: "with_caveat",
    notes: "Used as the viewer location when a brand browses creators.",
    coverage: { entity: "brand", field: "locationState" },
    priority: "optional",
  },
  {
    signal: "brand.campaignHistory",
    category: "COLLABORATION_HISTORY",
    source: "campaigns (by brandId) + platform_events",
    type: "numeric",
    nullable: true,
    derived: true,
    currentUsage: ["admin metrics (Stage 2B owners)"],
    safeForMatching: "with_caveat",
    notes: "Few campaigns so far; see campaignVolume.",
    availabilityOverride: "DERIVED",
    priority: "optional",
  },
];

/** What a brand can specify on a campaign, and what the platform does with it today. */
export interface CampaignRequirementDefinition {
  requirement: string;
  fields: string[];
  supportedInForm: boolean;
  stored: boolean;
  normalized: "yes" | "partial" | "no";
  usedInSearch: boolean;
  usedInEligibility: boolean;
  usedInInvitations: boolean;
  usedInCampaignAlerts: boolean;
  notes: string;
  /** Field key in the measured campaign coverage table. */
  coverageField?: string;
  priority: "critical" | "important" | "optional";
}

export const CAMPAIGN_REQUIREMENTS: CampaignRequirementDefinition[] = [
  {
    requirement: "Platform",
    fields: ["platforms[]", "platformPreference", "socialMedia[].platform"],
    supportedInForm: true,
    stored: true,
    normalized: "partial",
    usedInSearch: false,
    usedInEligibility: true,
    usedInInvitations: true,
    usedInCampaignAlerts: true,
    notes:
      'Display names ("Instagram"); platformPreference is lower-cased platforms[0]. Eligibility uses platforms only to scope the tier check. Invites store selectedPlatform.',
    coverageField: "platforms",
    priority: "critical",
  },
  {
    requirement: "Category",
    fields: ["categories[]"],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: true,
    notes:
      "From the categories master list. Only the campaign-alert matcher uses it (categories $in).",
    coverageField: "categories",
    priority: "critical",
  },
  {
    requirement: "Content type & price per deliverable",
    fields: ["socialMedia[].contentTypes[] (name, enabled, price)"],
    supportedInForm: true,
    stored: true,
    normalized: "partial",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: true,
    usedInCampaignAlerts: false,
    notes:
      "Drives the invite's selectedContentType / offered amount. Same per-platform names as creators (no cross-platform key).",
    coverageField: "pricedDeliverables",
    priority: "critical",
  },
  {
    requirement: "Deliverables (description)",
    fields: ["deliverables[]"],
    supportedInForm: true,
    stored: true,
    normalized: "no",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: false,
    notes:
      'Free text (e.g. "1 Reel or", "Or"). Not machine-readable; content types above are the structured equivalent.',
    coverageField: "deliverables",
    priority: "optional",
  },
  {
    requirement: "Minimum creator tier",
    fields: ["minInfluencerTier"],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: true,
    usedInInvitations: false,
    usedInCampaignAlerts: true,
    notes:
      "Enforced only for campaignMode 'tier_filtered_open' (exact tier on a campaign platform).",
    coverageField: "minInfluencerTier",
    priority: "important",
  },
  {
    requirement: "Target tiers",
    fields: ["targetTiers[]"],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: true,
    notes: "Only the campaign-alert matcher reads it.",
    coverageField: "targetTiers",
    priority: "important",
  },
  {
    requirement: "Follower range",
    fields: ["minFollowerCount", "maxFollowerCount"],
    supportedInForm: false,
    stored: true,
    normalized: "no",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: false,
    notes:
      "Nothing reads or enforces them (only an unused photographer collaboration form ever wrote minFollowerCount). Creator follower counts are also unreliable (all 0).",
    coverageField: "followerRange",
    priority: "optional",
  },
  {
    requirement: "Location (state / district / cities)",
    fields: [
      "targetState",
      "targetDistrict",
      "targetCities[]",
      "venue* (photographer)",
    ],
    supportedInForm: true,
    stored: true,
    normalized: "partial",
    usedInSearch: false,
    usedInEligibility: true,
    usedInInvitations: false,
    usedInCampaignAlerts: true,
    notes:
      "State/district: case-insensitive equality in eligibility (tier_filtered_open), exact equality in alerts. Since Stage 3B-1 the form saves the district to targetDistrict (validated against the districts master list); before that it went only to targetCities[0], which eligibility and alerts ignore. targetCities now mirrors the district for legacy readers.",
    coverageField: "targetState",
    priority: "important",
  },
  {
    requirement: "Language",
    fields: [],
    supportedInForm: false,
    stored: false,
    normalized: "no",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: false,
    notes:
      "Not supported: campaigns have no language field (creators do have languages[]).",
    priority: "important",
  },
  {
    requirement: "Audience requirements (age, gender, region of audience)",
    fields: [],
    supportedInForm: false,
    stored: false,
    normalized: "no",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: false,
    notes: "Not supported, and no audience data exists on creators either.",
    priority: "optional",
  },
  {
    requirement: "Budget",
    fields: ["budgetMin", "budgetMax", "estimatedBudget", "pricePerInfluencer"],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: false,
    usedInCampaignAlerts: false,
    notes:
      "Amounts in paise. Per-deliverable prices (content types) are what invites actually use.",
    coverageField: "budget",
    priority: "important",
  },
  {
    requirement: "Campaign dates",
    fields: [
      "startDate",
      "endDate",
      "timelineStart",
      "timelineEnd",
      "acceptanceDeadline",
    ],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: false,
    usedInInvitations: true,
    usedInCampaignAlerts: false,
    notes: "Deadlines drive invite expiry/auto-close jobs.",
    coverageField: "dates",
    priority: "optional",
  },
  {
    requirement: "Campaign type / mode / status",
    fields: [
      "campaignType",
      "campaignMode",
      "status",
      "ownerType",
      "inviteRecipientRole",
    ],
    supportedInForm: true,
    stored: true,
    normalized: "yes",
    usedInSearch: false,
    usedInEligibility: true,
    usedInInvitations: true,
    usedInCampaignAlerts: true,
    notes:
      "Mongoose enums. campaignMode decides whether requirement-based eligibility applies at all.",
    priority: "critical",
  },
];

/** What creator Search does today — documentation, kept apart from future matching. */
export const SEARCH_AND_RANKING = {
  description:
    "Current creator Search (GET influencers via UsersService.getInfluencers). Documented, not changed.",
  eligibility: [
    "status 'accepted', not deleted, not suspended",
    "verificationStatus 'approved' OR verifiedByTrendStarz",
    "email AND mobile verified",
    "has a profile photo and location.state",
    "at least one social account with a handle and (tier OR followersCount > 0)",
    "profileVisibility not PRIVATE (MEMBERS_ONLY hidden from guests)",
    "no open public-visibility-blocking profile flags",
  ],
  serverFilters: [
    "state",
    "district",
    "category",
    "creatorType",
    "q (text)",
    "campaignEligible",
  ],
  clientFilters: ["follower tier", "age range", "TrendScore band", "keyword"],
  serverRanking: [
    "1. location priority vs the viewer (district → state → country)",
    "2. currently Premium",
    "3. profileCompletion",
    "4. last activity (lastLoginAt → lastOpenedAt → updatedAt → createdAt)",
    "5. top followersCount — inert today (all 0)",
    "6. updatedAt",
    "7. random",
  ],
  clientSorts: [
    "recommended (server order)",
    "recently active",
    "new members",
    "verified first",
    "TrendStarz Recommended then TrendScore",
    "Premium first",
    "lowest price",
    "highest followers (inert: all 0)",
    "TrendScore high→low (loaded batch only)",
  ],
  participation: {
    trendScore:
      "client-side sort/filter and display only — not in server ranking",
    followerTier:
      "client-side filter; eligibility needs a tier on some account",
    verification:
      "profile approval gates eligibility; per-account 3A-1 verification is NOT used",
    activity: "server ranking step 4",
    observation: "not used",
  },
  existingRuleBasedMatching:
    "CampaignsService.notifyMatchingInfluencers (campaign alerts on publish): exact location, categories $in, campaign platforms, targetTiers / minInfluencerTier. It does not check profile approval and uses display-name platforms.",
};

/** How DECLARED / VERIFIED / OBSERVED / DERIVED should be treated later. No weights. */
export const DATA_CONFIDENCE_SEMANTICS = [
  {
    level: "DECLARED",
    meaning:
      "Entered by the creator (profile, socialMedia[], tier, rates, self-reported stats).",
    use: "Valid as the creator's own claim; never as proof.",
  },
  {
    level: "VERIFIED",
    meaning:
      "An explicit admin decision (Stage 3A-1), tied to a snapshot of what was reviewed; reset when the handle/tier changes.",
    use: "Proof of what was reviewed, at review time. Pending/rejected are not verified.",
  },
  {
    level: "OBSERVED",
    meaning:
      "What the platform API reported (Stage 3A-2), with capture time and source. Exact account resolution only.",
    use: "Evidence of audience at capture time. Can be stale; absent for unconnected Meta accounts.",
  },
  {
    level: "DERIVED",
    meaning:
      "Calculated from TrendStarZ history (platform_events, campaigns, invites).",
    use: "Only once the metric is READY (see derivedMetricReadiness); always with its sample size.",
  },
];

/** Proposed normalized input for a future deterministic matcher. status: existing | derived | future. */
export const FUTURE_MATCHING_CONTRACT = {
  campaign: {
    platforms: {
      status: "existing",
      from: "campaigns.platforms[] → platformKey",
    },
    categories: { status: "existing", from: "campaigns.categories[]" },
    contentTypes: {
      status: "existing",
      from: "campaigns.socialMedia[].contentTypes[] (enabled, price)",
    },
    minTier: {
      status: "existing",
      from: "campaigns.minInfluencerTier / targetTiers[] (rarely set)",
    },
    followerRange: {
      status: "future",
      from: "campaigns.min/maxFollowerCount exist in schema but nothing reads or enforces them",
    },
    location: {
      status: "existing",
      from: "campaigns.targetState / targetDistrict",
    },
    language: { status: "future", from: "not stored on campaigns" },
    budget: {
      status: "existing",
      from: "per-deliverable prices; budgetMin/Max rarely set",
    },
    dates: {
      status: "existing",
      from: "startDate / endDate / acceptanceDeadline",
    },
  },
  creator: {
    platforms: { status: "existing", from: "socialMedia[].platformKey" },
    categories: { status: "existing", from: "categories[]" },
    contentTypes: {
      status: "existing",
      from: "socialMedia[].contentTypes[] (needs name normalization)",
    },
    rates: { status: "existing", from: "socialMedia[].contentTypes[].price" },
    declaredTier: { status: "existing", from: "socialMedia[].tier" },
    verifiedTier: {
      status: "existing",
      from: "social_account_verifications (sparse)",
    },
    observedFollowers: {
      status: "existing",
      from: "social_account_observations (sparse)",
    },
    location: { status: "existing", from: "location.state / district" },
    languages: { status: "existing", from: "languages[]" },
    availability: {
      status: "existing",
      from: "collaborationAvailability.enabled, lastLoginAt",
    },
    trendScore: { status: "derived", from: "collaboration_audits (isCurrent)" },
    historicalSignals: {
      status: "derived",
      from: "platform_events — see derivedMetricReadiness",
    },
  },
};
