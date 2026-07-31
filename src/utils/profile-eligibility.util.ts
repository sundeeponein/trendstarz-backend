/**
 * Shared discovery/featured eligibility policy.
 *
 * A profile is discoverable only when:
 * - email is verified
 * - mobile is verified
 * - admin approved (verificationStatus=approved OR verifiedByTrendStarz=true)
 * - status is active/accepted
 * - not deleted/suspended
 * - profile visibility allows discovery for the current viewer
 */
export interface DiscoverabilityOptions {
  /** Field holding the primary photo array — "profileImages" for Influencer/Photographer, "brandLogo" for Brand. */
  photoField?: string;
  /** Influencer/Photographer need a social handle + tier/followers to be discoverable; Brand does not. Defaults to true. */
  requireSocialTier?: boolean;
  /** Whether the caller viewing discovery results is logged in. */
  viewerIsAuthenticated?: boolean;
}

export interface ViewerLocationContext {
  district?: string;
  state?: string;
  country?: string;
  /**
   * Future-ready metadata for guest geolocation strategy:
   * - registered_profile
   * - guest_browser
   * - guest_ip
   * - country_fallback
   * - none
   */
  source?:
    | "registered_profile"
    | "guest_browser"
    | "guest_ip"
    | "country_fallback"
    | "none";
}

export interface SearchEligibilityOptions extends DiscoverabilityOptions {}

function defaultDiscoveryCountry(): string {
  return String(process.env.DISCOVERY_DEFAULT_COUNTRY || "india")
    .trim()
    .toLowerCase();
}

export function normalizeLocationValue(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isAdminApproved(profile: any): boolean {
  return (
    String(profile?.verificationStatus || "").toLowerCase() === "approved" ||
    profile?.verifiedByTrendStarz === true
  );
}

export function profileVisibilityAllowsDiscovery(
  profileVisibility: unknown,
  viewerIsAuthenticated: boolean,
): boolean {
  const value = String(profileVisibility || "PUBLIC").toUpperCase();
  if (value === "PRIVATE") return false;
  if (value === "MEMBERS_ONLY" && !viewerIsAuthenticated) return false;
  return true;
}

export function isDiscoverableProfile(
  profile: any,
  options: DiscoverabilityOptions = {},
): boolean {
  const photoField = options.photoField || "profileImages";
  const viewerIsAuthenticated = !!options.viewerIsAuthenticated;
  const requireSocialTier = options.requireSocialTier !== false;

  if (String(profile?.status || "").toLowerCase() !== "accepted") return false;
  if (profile?.isDeleted === true) return false;
  if (String(profile?.accountStatus || "").toLowerCase() === "suspended")
    return false;
  if (profile?.isEmailVerified !== true) return false;
  if (profile?.isMobileVerified !== true) return false;
  if (!isAdminApproved(profile)) return false;
  if (
    !profileVisibilityAllowsDiscovery(
      profile?.profileVisibility,
      viewerIsAuthenticated,
    )
  ) {
    return false;
  }

  const photos = profile?.[photoField];
  if (!Array.isArray(photos) || photos.length === 0) return false;
  if (!String(profile?.location?.state || "").trim()) return false;

  if (!requireSocialTier) return true;
  const social = Array.isArray(profile?.socialMedia) ? profile.socialMedia : [];
  return social.some((item: any) => {
    const handle = String(item?.handle || "").trim();
    const tier = String(item?.tier || "").trim();
    const followers = Number(item?.followersCount || 0);
    return !!handle && (!!tier || followers > 0);
  });
}

/**
 * Shared "discoverable profile" DB filter. Mutates `filter` in place and
 * returns it so callers can append additional constraints.
 */
export function applyDiscoverableProfileFilter(
  filter: Record<string, any> = {},
  options: DiscoverabilityOptions = {},
): Record<string, any> {
  const photoField = options.photoField || "profileImages";
  filter.status = "accepted";
  filter.isDeleted = { $ne: true };
  filter.isEmailVerified = true;
  filter.isMobileVerified = true;
  filter.profileVisibility = {
    $nin: options.viewerIsAuthenticated
      ? ["PRIVATE"]
      : ["PRIVATE", "MEMBERS_ONLY"],
  };

  const andConditions: any[] = [
    ...(Array.isArray(filter.$and) ? filter.$and : []),
    {
      $or: [
        { verificationStatus: "approved" },
        { verifiedByTrendStarz: true },
      ],
    },
    { [`${photoField}.0`]: { $exists: true } },
    { "location.state": { $exists: true, $nin: ["", null] } },
    {
      $or: [
        { accountStatus: { $exists: false } },
        { accountStatus: { $nin: ["suspended", "SUSPENDED"] } },
      ],
    },
  ];

  if (options.requireSocialTier !== false) {
    andConditions.push({
      socialMedia: {
        $elemMatch: {
          handle: { $exists: true, $nin: ["", null] },
          $or: [
            { tier: { $exists: true, $nin: ["", null] } },
            { followersCount: { $gt: 0 } },
          ],
        },
      },
    });
  }

  filter.$and = andConditions;
  return filter;
}

/** Backward-compatible alias retained for existing callers. */
export function applySearchEligibilityFilter(
  filter: Record<string, any> = {},
  options: SearchEligibilityOptions = {},
): Record<string, any> {
  return applyDiscoverableProfileFilter(filter, options);
}

export interface ApprovedEligibilityOptions extends DiscoverabilityOptions {
  /**
   * Require an active Premium subscription. The Homepage Hero always
   * requires this (guest and logged-in alike). The Featured Grid sections
   * require it only for guest viewers — logged-in viewers see a broader
   * Public + Members-Only set without the Premium bar, as an incentive to
   * register.
   */
  requirePremium?: boolean;
}

/**
 * "Is this profile recommended by TrendStarZ?" — Welcome/Featured eligibility.
 * Everything Search requires, plus admin approval.
 */
export function applyApprovedEligibilityFilter(
  filter: Record<string, any> = {},
  options: ApprovedEligibilityOptions = {},
): Record<string, any> {
  applyDiscoverableProfileFilter(filter, options);
  if (options.requirePremium) {
    filter.isPremium = true;
    filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), {
      $or: [{ premiumEnd: null }, { premiumEnd: { $gte: new Date() } }],
    }];
  }
  return filter;
}

function normalizedCountry(value: unknown): string {
  const normalized = normalizeLocationValue(value);
  return normalized || defaultDiscoveryCountry();
}

export function getLocationPriorityTier(
  profile: any,
  viewer: ViewerLocationContext = {},
): number {
  const viewerCountry = normalizedCountry(viewer.country);
  const viewerState = normalizeLocationValue(viewer.state);
  const viewerDistrict = normalizeLocationValue(viewer.district);

  const profileCountry = normalizedCountry(profile?.location?.country);
  const profileState = normalizeLocationValue(profile?.location?.state);
  const profileDistrict = normalizeLocationValue(profile?.location?.district);

  if (
    viewerDistrict &&
    viewerState &&
    profileDistrict &&
    profileState &&
    viewerDistrict === profileDistrict &&
    viewerState === profileState
  ) {
    return 4;
  }
  if (viewerState && profileState && viewerState === profileState) {
    return 3;
  }
  if (viewerCountry && profileCountry && viewerCountry === profileCountry) {
    return 2;
  }
  return 1;
}

export function buildLocationPriorityExpr(viewer: ViewerLocationContext = {}): any {
  const viewerDistrict = normalizeLocationValue(viewer.district);
  const viewerState = normalizeLocationValue(viewer.state);
  const viewerCountry = normalizedCountry(viewer.country);

  const profileDistrict = {
    $toLower: { $trim: { input: { $ifNull: ["$location.district", ""] } } },
  };
  const profileState = {
    $toLower: { $trim: { input: { $ifNull: ["$location.state", ""] } } },
  };
  const profileCountry = {
    $toLower: {
      $trim: {
        input: { $ifNull: ["$location.country", defaultDiscoveryCountry()] },
      },
    },
  };

  return {
    $switch: {
      branches: [
        {
          case: {
            $and: [
              { $ne: [viewerDistrict, ""] },
              { $ne: [viewerState, ""] },
              { $eq: [profileDistrict, viewerDistrict] },
              { $eq: [profileState, viewerState] },
            ],
          },
          then: 4,
        },
        {
          case: {
            $and: [
              { $ne: [viewerState, ""] },
              { $eq: [profileState, viewerState] },
            ],
          },
          then: 3,
        },
        {
          case: {
            $and: [
              { $ne: [viewerCountry, ""] },
              { $eq: [profileCountry, viewerCountry] },
            ],
          },
          then: 2,
        },
      ],
      default: 1,
    },
  };
}

function selectStringToProjection(fields: string): Record<string, 1> {
  const projection: Record<string, 1> = { _id: 1 };
  fields
    .split(/\s+/)
    .filter(Boolean)
    .forEach((field) => {
      projection[field] = 1;
    });
  return projection;
}

/** [maxDaysSince, score] pairs, evaluated in order — first match wins, else 0. */
type DecayCurve = Array<[number, number]>;

function daysSinceExpr(dateExpr: any): any {
  return { $divide: [{ $subtract: ["$$NOW", dateExpr] }, 1000 * 60 * 60 * 24] };
}

function decayScoreExpr(days: any, curve: DecayCurve): any {
  return {
    $switch: {
      branches: curve.map(([maxDays, score]) => ({
        case: { $lte: [days, maxDays] },
        then: score,
      })),
      default: 0,
    },
  };
}

export interface FeaturedActivityLookup {
  /** Mongo collection name to join against for the "recent hires / campaign activity" factor. */
  from: string;
  /** Field on the joined collection that references this profile's _id (may be stored as ObjectId or string — both are matched). */
  matchField: string;
  /** Only count joined docs whose status is one of these. Omit to count all matches regardless of status. */
  statusIn?: string[];
  /** Field on the joined collection to test recency against. */
  dateField: string;
  /** How many days back counts as "recent" for this factor. */
  windowDays: number;
}

interface FeaturedProfileModel {
  aggregate: (pipeline: any[]) => Promise<any[]>;
}

export interface SearchRankingOptions {
  /** Mongo collection name used for response-rate aggregation (usually campaigninvites). */
  invitesCollection: string;
  /** Field on invites collection referencing the profile id. */
  inviteMatchField: string;
  /** Extra static match fields for invite lookup (for role-specific invites). */
  inviteStaticMatch?: Record<string, any>;
  /** Mongo collection name used for ratings aggregation. */
  reviewsCollection: string;
  /** targetType value in reviews collection (influencer|photographer). */
  reviewTargetType: string;
}

export function buildSearchRankingStages(
  viewer: ViewerLocationContext,
  options: SearchRankingOptions,
): any[] {
  const acceptedStatuses = [
    "accepted",
    "payment_confirmed",
    "working",
    "submitted",
    "completed",
    "approved",
  ];
  const responseStatuses = ["accepted", "declined"];
  const activityDateExpr = {
    $ifNull: [
      "$lastLoginAt",
      { $ifNull: ["$lastOpenedAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
    ],
  };

  return [
    {
      $lookup: {
        from: options.reviewsCollection,
        let: { pid: { $toString: "$_id" } },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$targetId", "$$pid"] },
                  { $eq: ["$targetType", options.reviewTargetType] },
                  { $eq: ["$status", "approved"] },
                ],
              },
            },
          },
          { $group: { _id: null, avgRating: { $avg: "$rating" } } },
        ],
        as: "_rating",
      },
    },
    {
      $lookup: {
        from: options.invitesCollection,
        let: { pid: "$_id", pidStr: { $toString: "$_id" } },
        pipeline: [
          {
            $match: {
              ...options.inviteStaticMatch,
              $expr: {
                $or: [
                  { $eq: [`$${options.inviteMatchField}`, "$$pid"] },
                  { $eq: [`$${options.inviteMatchField}`, "$$pidStr"] },
                ],
              },
              status: { $in: responseStatuses },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              accepted: {
                $sum: {
                  $cond: [{ $eq: ["$status", "accepted"] }, 1, 0],
                },
              },
            },
          },
        ],
        as: "_response",
      },
    },
    {
      $addFields: {
        _locationTier: buildLocationPriorityExpr(viewer),
        _premiumBoost: {
          $cond: [
            {
              $and: [
                { $eq: ["$isPremium", true] },
                {
                  $or: [
                    { $eq: ["$premiumEnd", null] },
                    { $gte: ["$premiumEnd", "$$NOW"] },
                  ],
                },
              ],
            },
            1,
            0,
          ],
        },
        _profileCompletionScore: { $ifNull: ["$profileCompletion", 0] },
        _campaignRatingScore: {
          $ifNull: [{ $arrayElemAt: ["$_rating.avgRating", 0] }, 0],
        },
        _responseRateScore: {
          $let: {
            vars: {
              total: { $ifNull: [{ $arrayElemAt: ["$_response.total", 0] }, 0] },
              accepted: {
                $ifNull: [{ $arrayElemAt: ["$_response.accepted", 0] }, 0],
              },
            },
            in: {
              $cond: [
                { $lte: ["$$total", 0] },
                0,
                { $multiply: [{ $divide: ["$$accepted", "$$total"] }, 100] },
              ],
            },
          },
        },
        _recentActivityScore: decayScoreExpr(daysSinceExpr(activityDateExpr), [
          [1, 100],
          [7, 80],
          [30, 60],
          [90, 35],
          [180, 20],
        ]),
        _recentCampaignActivityScore: {
          $ifNull: [{ $arrayElemAt: ["$_response.accepted", 0] }, 0],
        },
        _topFollowersScore: {
          $max: {
            $map: {
              input: { $ifNull: ["$socialMedia", []] },
              as: "sm",
              in: { $ifNull: ["$$sm.followersCount", 0] },
            },
          },
        },
        _updatedAtScore: { $ifNull: ["$updatedAt", new Date(0)] },
        _randomRotation: { $rand: {} },
        _acceptedInviteCount: {
          $size: {
            $filter: {
              input: { $ifNull: ["$_response", []] },
              as: "resp",
              cond: { $gt: ["$$resp.accepted", 0] },
            },
          },
        },
      },
    },
    {
      $addFields: {
        _campaignPerformanceScore: {
          $add: [
            { $multiply: ["$_campaignRatingScore", 10] },
            "$_responseRateScore",
            { $min: [50, { $multiply: ["$_recentCampaignActivityScore", 3] }] },
          ],
        },
      },
    },
    {
      $sort: {
        _locationTier: -1,
        _premiumBoost: -1,
        _profileCompletionScore: -1,
        _campaignRatingScore: -1,
        _responseRateScore: -1,
        _recentActivityScore: -1,
        _topFollowersScore: -1,
        _updatedAtScore: -1,
        _randomRotation: -1,
      },
    },
  ];
}

/**
 * Weight breakdown for the Welcome Page "Featured" score (sums to 100):
 *   Premium Membership ........ 15   — active premium subscription (kept modest —
 *                                      a small premium cohort shouldn't dominate exposure)
 *   Recently Active ............ 20   — lastLoginAt/lastOpenedAt recency, decayed
 *   Recently Joined ............ 10   — createdAt recency, decayed (gives new approved users a chance)
 *   Profile Completeness ....... 20   — reuses the existing `profileCompletion` (0-100) field
 *   Recent Hires/Campaign Activity 15  — recent matching docs in `activity.from` (invites for
 *                                        Influencer/Photographer, campaigns for Brand)
 *   Random Rotation ............ 20   — `$rand`; the largest single weight, so free/inactive
 *                                       profiles keep getting real exposure instead of the
 *                                       same small premium/active cohort always winning
 *
 * Computed entirely inside one aggregation pipeline (including the activity
 * join) so there is no JS-side candidate-pool cap to outgrow as a role's
 * eligible count scales up — the DB sorts/limits the whole filtered set.
 *
 * NOTE: this score is Welcome-Page-only (a marketing surface). The Search
 * Page must not use it — Search needs its own, separately-defined ranking.
 */
export async function fetchFeaturedProfilesByScore<T extends { _id: any }>(
  model: FeaturedProfileModel,
  filter: Record<string, any>,
  selectFields: string,
  limit: number,
  activity: FeaturedActivityLookup,
  viewerLocation?: ViewerLocationContext,
): Promise<T[]> {
  if (limit <= 0) return [];

  const activityDateExpr = {
    $ifNull: [
      "$lastLoginAt",
      { $ifNull: ["$lastOpenedAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
    ],
  };
  const joinDateExpr = { $ifNull: ["$createdAt", "$firstRegisteredAt"] };
  const activityCutoff = new Date(Date.now() - activity.windowDays * 86400000);
  const activityStatusMatch = activity.statusIn?.length
    ? { status: { $in: activity.statusIn } }
    : {};

  const pipeline: any[] = [
    { $match: filter },
    {
      $lookup: {
        from: activity.from,
        let: { pid: "$_id", pidStr: { $toString: "$_id" } },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: [`$${activity.matchField}`, "$$pid"] },
                  { $eq: [`$${activity.matchField}`, "$$pidStr"] },
                ],
              },
              ...activityStatusMatch,
              [activity.dateField]: { $gte: activityCutoff },
            },
          },
          { $count: "count" },
        ],
        as: "_recentActivity",
      },
    },
    {
      $addFields: {
        _recentActivityCount: {
          $ifNull: [{ $arrayElemAt: ["$_recentActivity.count", 0] }, 0],
        },
      },
    },
    {
      $addFields: {
        _featuredScore: {
          $sum: [
            // Premium Membership (+15) — kept modest so a small premium cohort can't dominate exposure
            {
              $cond: [
                {
                  $and: [
                    { $eq: ["$isPremium", true] },
                    {
                      $or: [
                        { $eq: ["$premiumEnd", null] },
                        { $gte: ["$premiumEnd", "$$NOW"] },
                      ],
                    },
                  ],
                },
                15,
                0,
              ],
            },
            // Recently Active (+20)
            decayScoreExpr(daysSinceExpr(activityDateExpr), [
              [1, 20],
              [7, 15],
              [30, 10],
              [90, 5],
            ]),
            // Recently Joined (+10)
            decayScoreExpr(daysSinceExpr(joinDateExpr), [
              [7, 10],
              [30, 5],
            ]),
            // Profile Completeness (+20) — reuses the stored 0-100 profileCompletion field
            {
              $multiply: [
                { $divide: [{ $ifNull: ["$profileCompletion", 0] }, 100] },
                20,
              ],
            },
            // Recent Hires / Campaign Activity (+15) — capped at 4+ recent matches
            { $min: [15, { $multiply: ["$_recentActivityCount", 3.75] }] },
            // Random Rotation (+20) — the larger weight so a small premium/active
            // cohort can't crowd out everyone else's exposure
            { $multiply: [{ $rand: {} }, 20] },
          ],
        },
      },
    },
    {
      $addFields: {
        _locationTier: viewerLocation
          ? buildLocationPriorityExpr(viewerLocation)
          : 1,
      },
    },
    { $sort: { _locationTier: -1, _featuredScore: -1 } },
    { $limit: limit },
    { $project: selectStringToProjection(selectFields) },
  ];

  return model.aggregate(pipeline) as Promise<T[]>;
}
