/**
 * Single source of truth for "is this profile eligible to be shown publicly"
 * (Welcome Page featured sections, and — later — Search Page discovery).
 * A profile is eligible only when ALL of:
 *   - status = "accepted"
 *   - isDeleted is not true (covers deleted/suspended)
 *   - isEmailVerified = true
 *   - isMobileVerified = true
 *   - verificationStatus = "approved" OR verifiedByTrendStarz = true
 *   - profile visibility is public (no such field exists on the schemas yet —
 *     once one is added, gate it here so every caller picks it up for free)
 *
 * Mutates `filter` in place and returns it, so it composes with callers that
 * already build up a filter object (matches the existing
 * `applyPublicDiscoveryEligibilityFilter` / `applyExcludedIds` convention).
 */
export function applyEligiblePublicProfileFilter(
  filter: Record<string, any> = {},
): Record<string, any> {
  filter.status = "accepted";
  filter.isDeleted = { $ne: true };
  filter.isEmailVerified = true;
  filter.isMobileVerified = true;
  filter.$and = [
    ...(Array.isArray(filter.$and) ? filter.$and : []),
    {
      $or: [{ verificationStatus: "approved" }, { verifiedByTrendStarz: true }],
    },
  ];
  return filter;
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
    { $sort: { _featuredScore: -1 } },
    { $limit: limit },
    { $project: selectStringToProjection(selectFields) },
  ];

  return model.aggregate(pipeline) as Promise<T[]>;
}
