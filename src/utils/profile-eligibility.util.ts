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

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

interface FeaturedProfileModel {
  find: (filter: any) => any;
  aggregate: (pipeline: any[]) => Promise<any[]>;
}

/**
 * Picks `limit` profiles for a Welcome Page "Featured" section using a weighted
 * mix — 60% most recently active, 20% most recently approved, 20% random — so
 * new approved users get a chance to surface and the same faces aren't
 * permanently featured. Each bucket is its own DB-sorted/DB-limited query
 * (rather than slicing one shared capped pool), so the result stays correct
 * regardless of how large a role's eligible pool grows — there is no count to
 * bump later.
 *
 * Requires `model` to have an `approvedAt` field set on approval (see
 * `profile-verification.service.ts` / `admin-user-table.controller.ts`) for
 * the "recently approved" bucket; profiles without it simply aren't eligible
 * for that specific bucket but can still surface via "active" or "random".
 */
export async function fetchFeaturedProfiles<T extends { _id: any }>(
  model: FeaturedProfileModel,
  filter: Record<string, any>,
  selectFields: string,
  limit: number,
): Promise<T[]> {
  if (limit <= 0) return [];

  const activeCount = Math.round(limit * 0.6);
  const approvedCount = Math.round(limit * 0.2);
  const picked = new Set<string>();
  const result: T[] = [];
  // Preserve any exclusion the caller already applied (e.g. blocked/flagged
  // profile ids) instead of clobbering it once we start excluding picked ids.
  const baseExcludedIds: any[] = Array.isArray(filter?._id?.$nin)
    ? filter._id.$nin
    : [];
  const withExclusions = () =>
    picked.size
      ? {
          ...filter,
          _id: { ...(filter._id || {}), $nin: [...baseExcludedIds, ...picked] },
        }
      : filter;

  const activeDocs = await model
    .find(withExclusions())
    .select(selectFields)
    .sort({ lastLoginAt: -1, updatedAt: -1 })
    .limit(activeCount)
    .lean();
  for (const doc of activeDocs as T[]) {
    result.push(doc);
    picked.add(String(doc._id));
  }

  if (result.length < limit) {
    const approvedDocs = await model
      .find({ ...withExclusions(), approvedAt: { $ne: null } })
      .select(selectFields)
      .sort({ approvedAt: -1 })
      .limit(Math.min(approvedCount, limit - result.length))
      .lean();
    for (const doc of approvedDocs as T[]) {
      result.push(doc);
      picked.add(String(doc._id));
    }
  }

  if (result.length < limit) {
    const randomDocs = await model.aggregate([
      { $match: withExclusions() },
      { $sample: { size: limit - result.length } },
      { $project: selectStringToProjection(selectFields) },
    ]);
    for (const doc of randomDocs as T[]) {
      result.push(doc);
      picked.add(String(doc._id));
    }
  }

  return shuffle(result);
}
