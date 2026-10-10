/**
 * Stage 3A-0 — the ONE canonical server-side follower-tier definition.
 *
 * Matches the `tiers` collection descriptions and frontend tiers.constants.ts
 * (which already agreed); replaces profile-verification's old TIER_RANGES,
 * which overlapped Macro/Mega (both 100,001+) and started Starter at 0.
 *
 * `label` is the exact string stored in socialMedia[].tier and the tiers
 * collection `name` — stored values are never rewritten. Starter/Nano are hidden
 * for NEW selections (tiers.showInFrontend=false) but stay fully valid here.
 *
 * Keep in sync with cron/lib/socialAccountIdentity.js (a spec checks this).
 */
export interface TierDefinition {
  key: string;
  label: string;
  minFollowers: number;
  /** null = no upper bound. */
  maxFollowers: number | null;
}

export const CANONICAL_TIERS: readonly TierDefinition[] = [
  { key: "starter", label: "Starter", minFollowers: 1, maxFollowers: 100 },
  { key: "nano", label: "Nano", minFollowers: 101, maxFollowers: 1_000 },
  { key: "micro", label: "Micro", minFollowers: 1_001, maxFollowers: 10_000 },
  {
    key: "mid_tier",
    label: "Mid-Tier",
    minFollowers: 10_001,
    maxFollowers: 100_000,
  },
  {
    key: "macro",
    label: "Macro",
    minFollowers: 100_001,
    maxFollowers: 1_000_000,
  },
  {
    key: "mega",
    label: "Mega / Celebrity",
    minFollowers: 1_000_001,
    maxFollowers: null,
  },
];

/** Label spellings seen in stored data / older UI → canonical key. */
const TIER_ALIASES: Record<string, string> = {
  starter: "starter",
  nano: "nano",
  micro: "micro",
  "mid-tier": "mid_tier",
  "mid tier": "mid_tier",
  midtier: "mid_tier",
  mid_tier: "mid_tier",
  macro: "macro",
  "mega / celebrity": "mega",
  "mega/celebrity": "mega",
  "mega celebrity": "mega",
  mega: "mega",
};

/** Canonical definition for a stored tier string (tolerates case, spacing and a trailing "(range)"). */
export function resolveTier(raw: unknown): TierDefinition | null {
  const text = (typeof raw === "string" ? raw : "")
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  const key = TIER_ALIASES[text];
  return key ? CANONICAL_TIERS.find((t) => t.key === key) || null : null;
}

/** Canonical tier whose range contains `followers`; null for ≤0 / invalid counts. */
export function tierForFollowers(followers: unknown): TierDefinition | null {
  const n = Number(followers);
  if (!Number.isFinite(n) || n < 1) return null;
  return (
    CANONICAL_TIERS.find(
      (t) =>
        n >= t.minFollowers && (t.maxFollowers === null || n <= t.maxFollowers),
    ) || null
  );
}

/**
 * Open-campaign tier rule: the creator's declared tier is AT LEAST the
 * campaign's minimum, by canonical order (Starter < Nano < Micro < Mid-Tier <
 * Macro < Mega). No minimum, or a minimum that isn't a canonical tier, means
 * no restriction (unchanged legacy behaviour); an unreadable creator tier
 * never qualifies.
 */
export function meetsMinimumTier(
  creatorTier: unknown,
  minimumTier: unknown,
): boolean {
  const min = resolveTier(minimumTier);
  if (!min) return true;
  const tier = resolveTier(creatorTier);
  if (!tier) return false;
  const rank = (key: string) => CANONICAL_TIERS.findIndex((t) => t.key === key);
  return rank(tier.key) >= rank(min.key);
}

/** "1,001–10,000 followers" (or "1,000,001+ followers") for a tier label/key; "" if unknown. */
export function tierRangeText(tier: unknown): string {
  const t = resolveTier(tier);
  if (!t) return "";
  const n = (v: number) => v.toLocaleString("en-IN");
  return t.maxFollowers === null
    ? `${n(t.minFollowers)}+ followers`
    : `${n(t.minFollowers)}–${n(t.maxFollowers)} followers`;
}
