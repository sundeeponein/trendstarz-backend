import { buildSocialAccountComparison } from "../social-account-comparison/social-account-comparison";
import { observationView } from "../social-account-observation/social-account-observation.service";
import {
  effectiveDecision,
  tierIdentity,
} from "../social-account-verification/social-account-verification.service";
import {
  CANONICAL_TIERS,
  resolveTier,
  tierForFollowers,
} from "../utils/tier-ranges.util";

/**
 * Automatic tier correction from a YouTube observation (pure). The system moves a
 * creator's declared tier to the observed one only when ALL safeguards hold:
 *
 *  - YouTube (an official count, not self-reported), status success;
 *  - the count is fresh (≤ 30 days — also YouTube's storage limit) and above 0;
 *  - the observed channel's handle matches the handle the creator gave (same account);
 *  - the count sits clearly inside its tier (±MARGIN), so 1,000 vs 1,001 can't flip it;
 *  - the observed tier differs from the declared one;
 *  - no admin decided this account's tier after the observation (a person always wins);
 *  - UPGRADES (subscribers grew) are applied every time they happen;
 *  - a DOWNGRADE is applied only if the system never auto-corrected this account before;
 *  - if the creator changed the tier themselves after an automatic change, the system
 *    stops changing it automatically — it waits in Tier Review for a person.
 * When the declared tier already MATCHES the observed one (same safeguards), the
 * account is verified automatically instead — no change, no notice — unless an admin
 * already verified it or REJECTED that tier (a rejection is never overridden).
 * Money never changes here: agreed/paid invites keep their amount (only open invites
 * show the creator that their tier changed, so they can use their counter-offer).
 */
export const AUTO_TIER = {
  maxAgeDays: 30,
  /** The tier must be the same at followers × (1 − margin) and × (1 + margin). */
  margin: 0.05,
  decidedByName: "Auto (YouTube observation)",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoTierSkip =
  | "not_youtube"
  | "no_count"
  | "stale"
  | "handle_mismatch"
  | "near_boundary"
  | "same_tier"
  | "admin_decided"
  | "already_auto_corrected"
  | "creator_override"
  | "already_verified"
  | "admin_rejected";

export type AutoTierResult =
  | {
      apply: true;
      action: "change";
      fromTier: string;
      toTier: string;
      direction: "up" | "down";
      followers: number;
      capturedAt: Date;
    }
  | {
      /** Declared tier already matches: verify it (no change, no notice). */
      apply: true;
      action: "verify";
      tier: string;
      followers: number;
      capturedAt: Date;
    }
  | { apply: false; reason: AutoTierSkip };

export function autoTierDecision(input: {
  entry: Record<string, any>;
  /** The account's social_account_observations doc. */
  observation: Record<string, any> | null | undefined;
  /** The account's social_account_verifications doc. */
  verification: Record<string, any> | null | undefined;
  now: Date;
}): AutoTierResult {
  const { entry, observation: obs, verification: ver, now } = input;
  const skip = (reason: AutoTierSkip): AutoTierResult => ({
    apply: false,
    reason,
  });

  const platformKey = String(entry?.platformKey || "").toLowerCase();
  if (platformKey !== "youtube" || obs?.source !== "youtube") {
    return skip("not_youtube");
  }
  const followers = Number(obs?.observedFollowersCount);
  if (
    obs?.status !== "success" ||
    !obs?.capturedAt ||
    !Number.isFinite(followers) ||
    followers <= 0
  ) {
    return skip("no_count");
  }
  const capturedAt = new Date(obs.capturedAt);
  const age = now.getTime() - capturedAt.getTime();
  if (!(age >= 0 && age <= AUTO_TIER.maxAgeDays * DAY_MS)) return skip("stale");

  const tierDecision = effectiveDecision("tier", ver?.tier, entry);
  const cmp = buildSocialAccountComparison(
    entry,
    { tierVerification: tierDecision },
    observationView(entry, obs),
  );
  if (cmp.comparison.handle.status !== "match") return skip("handle_mismatch");

  const observed = tierForFollowers(followers);
  const low = tierForFollowers(Math.floor(followers * (1 - AUTO_TIER.margin)));
  const high = tierForFollowers(Math.ceil(followers * (1 + AUTO_TIER.margin)));
  if (!observed || low?.key !== observed.key || high?.key !== observed.key) {
    return skip("near_boundary");
  }
  if (tierIdentity(entry?.tier) === observed.key) {
    if (tierDecision.status === "verified") return skip("already_verified");
    if (tierDecision.status === "rejected") return skip("admin_rejected");
    return {
      apply: true,
      action: "verify",
      tier: observed.label,
      followers,
      capturedAt,
    };
  }

  const rank = (key: string | undefined) =>
    CANONICAL_TIERS.findIndex((t) => t.key === key);
  const declaredRank = rank(resolveTier(entry?.tier)?.key);
  // Unknown declared tier counts as a correction up (there is nothing to lose).
  const direction: "up" | "down" =
    declaredRank < 0 || rank(observed.key) > declaredRank ? "up" : "down";

  const autoAt = ver?.tierAutoAppliedAt
    ? new Date(ver.tierAutoAppliedAt)
    : null;
  if (autoAt) {
    // The creator changed the tier after our automatic change: respect it.
    const changedAt = ver?.tier?.invalidatedAt
      ? new Date(ver.tier.invalidatedAt)
      : null;
    if (
      ver?.tier?.invalidatedReason === "tier_changed" &&
      changedAt &&
      changedAt.getTime() > autoAt.getTime()
    ) {
      return skip("creator_override");
    }
    if (direction === "down") return skip("already_auto_corrected");
  }
  const decidedAt = ver?.tier?.decidedAt ? new Date(ver.tier.decidedAt) : null;
  if (
    ver?.tier?.method === "manual" &&
    decidedAt &&
    decidedAt.getTime() >= capturedAt.getTime()
  ) {
    return skip("admin_decided");
  }

  return {
    apply: true,
    action: "change",
    fromTier: String(entry?.tier ?? ""),
    toTier: observed.label,
    direction,
    followers,
    capturedAt,
  };
}
