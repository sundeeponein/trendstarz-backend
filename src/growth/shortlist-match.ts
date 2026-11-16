import { ACTIVITY_BUCKET_ORDER, activityBucket } from "../matching-eligibility/match-ranking";

/**
 * "Build shortlist" for a brand's shortlist request (2026-11-16). There is no
 * campaign yet, so the request's state + niche pick the creators and the same
 * kind of plain, ordered tie-breaks as campaign matching rank them — no score:
 *   1. main category is the requested niche
 *   2. same city / district
 *   3. activity (same buckets as campaign matching)
 *   4. tier verified by TrendStarZ (any platform)
 *   5. lowest Reel/Shorts rate fits the budget (per creator: budget ÷ 5)
 *   6. publicId — stable final tie-break
 */

/** Rough per-creator ceiling: the budget spread over the 5 creators we send. */
export const BUDGET_PER_CREATOR: Record<string, number | null> = {
  under_5k: 1000,
  "5k_20k": 4000,
  "20k_50k": 10000,
  "50k_plus": null,
  barter: null,
  not_sure: null,
};

export interface ShortlistCandidate {
  id: string;
  name: string;
  username: string;
  publicId: string;
  city: string;
  state: string;
  mainCategory: string;
  categories: string[];
  accounts: Array<{ platform: string; handle: string; tier: string; followers: number | null; verified: boolean }>;
  /** Lowest enabled Reel/Shorts price, else lowest enabled price (₹), null when none. */
  rate: { name: string; price: number } | null;
  lastActiveAt: string | null;
  sameCity: boolean;
  mainMatch: boolean;
  verified: boolean;
  /** true = within budget, false = above it, null = no budget limit or no price. */
  fitsBudget: boolean | null;
  reasons: string[];
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function lowestRate(socialMedia: any[]): { name: string; price: number } | null {
  let best: { name: string; price: number; short: boolean } | null = null;
  for (const sm of Array.isArray(socialMedia) ? socialMedia : []) {
    for (const ct of Array.isArray(sm?.contentTypes) ? sm.contentTypes : []) {
      const price = Number(ct?.price);
      if (ct?.enabled === false || !Number.isFinite(price) || price <= 0) continue;
      const short = /reel|short/i.test(String(ct?.name || ""));
      if (
        !best ||
        (short && !best.short) ||
        (short === best.short && price < best.price)
      ) {
        best = { name: String(ct.name), price, short };
      }
    }
  }
  return best ? { name: best.name, price: best.price } : null;
}

export function rankShortlist(
  request: { city?: string; category?: string; budget?: string },
  creators: any[],
  verifiedById: Map<string, Set<string>>,
  asOf: Date,
): ShortlistCandidate[] {
  const cap = BUDGET_PER_CREATOR[String(request.budget || "")] ?? null;
  const city = norm(request.city);
  const niche = norm(request.category);
  const rows = creators.map((c) => {
    const id = String(c._id);
    const verifiedAccounts = verifiedById.get(id) || new Set<string>();
    const lastActive = [c.lastLoginAt, c.lastOpenedAt]
      .map((d) => (d ? new Date(d).getTime() : NaN))
      .filter(Number.isFinite);
    const lastActiveAt = lastActive.length ? new Date(Math.max(...lastActive)) : null;
    const { bucket } = activityBucket(lastActiveAt, asOf);
    const district = norm(c.location?.district || c.location?.city);
    const sameCity = !!city && !!district && (district === city || district.includes(city) || city.includes(district));
    const mainMatch = !!niche && norm(c.influencerCategory) === niche;
    const rate = lowestRate(c.socialMedia);
    const fitsBudget = cap === null || !rate ? null : rate.price <= cap;
    const accounts = (Array.isArray(c.socialMedia) ? c.socialMedia : [])
      .filter((s: any) => s?.handle)
      .map((s: any) => ({
        platform: String(s.platform || ""),
        handle: String(s.handle || "").replace(/^@+/, ""),
        tier: String(s.tier || ""),
        followers: Number(s.followersCount) > 0 ? Number(s.followersCount) : null,
        verified: verifiedAccounts.has(String(s.socialAccountId || "")),
      }));
    const verified = accounts.some((a: any) => a.verified);
    const reasons = [
      mainMatch ? `Main niche is ${c.influencerCategory}` : `Works in ${request.category}`,
      sameCity ? `Based in ${c.location?.district || c.location?.city}` : "",
      bucket === "within_7_days" ? "Active this week" : bucket === "within_8_30_days" ? "Active this month" : bucket === "over_90_days" ? "Not active for 90+ days" : "",
      verified ? "Tier verified by TrendStarZ" : "",
      fitsBudget === true ? "Rate fits the budget" : fitsBudget === false ? "Rate above the budget" : "",
    ].filter(Boolean);
    return {
      key: [
        mainMatch ? 0 : 1,
        sameCity ? 0 : 1,
        ACTIVITY_BUCKET_ORDER[bucket],
        verified ? 0 : 1,
        fitsBudget === true ? 0 : fitsBudget === null ? 1 : 2,
      ],
      candidate: {
        id,
        name: String(c.name || c.username || ""),
        username: String(c.username || ""),
        publicId: String(c.publicId || ""),
        city: String(c.location?.district || c.location?.city || ""),
        state: String(c.location?.state || ""),
        mainCategory: String(c.influencerCategory || ""),
        categories: Array.isArray(c.categories) ? c.categories.map(String) : [],
        accounts,
        rate,
        lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
        sameCity,
        mainMatch,
        verified,
        fitsBudget,
        reasons,
      } as ShortlistCandidate,
    };
  });
  rows.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.candidate.publicId.localeCompare(b.candidate.publicId);
  });
  return rows.map((r) => r.candidate);
}
