import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { buildSocialAccountComparison } from "../social-account-comparison/social-account-comparison";
import { observationView } from "../social-account-observation/social-account-observation.service";
import { tierIdentity } from "../social-account-verification/social-account-verification.service";
import { tierForFollowers } from "../utils/tier-ranges.util";
import { AUTO_TIER } from "./tier-auto-apply";

/**
 * What the creator should do about a checked count:
 *  - matches: their declared tier is the observed one (auto_updated: we changed it);
 *  - please_update: same channel, different tier — they should update it;
 *  - check_handle: the channel we found has a different handle — the count may not
 *    be theirs, so they should check the handle rather than the tier.
 */
export type YoutubeCheckStatus =
  | "matches"
  | "please_update"
  | "check_handle"
  // Same channel (found by its permanent id) under a new handle: update the handle.
  | "handle_renamed"
  // 2+ lookups in a row found no channel for the handle: check it.
  | "not_found";

/** Failed lookups in a row before the creator is told their channel can't be found. */
export const NOT_FOUND_AFTER_FAILURES = 2;
const NOT_FOUND_REASONS = ["external_account_not_found", "account_mismatch"];

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE_TYPE: Record<string, string> = {
  influencer: "Influencer",
  photographer: "Photographer",
};
const COLLECTION: Record<string, string> = {
  Influencer: "influencers",
  Photographer: "photographers",
};

/**
 * A creator's OWN checked YouTube counts, for their profile page ("TrendStarZ
 * checked your channel: 815 subscribers on 9 Oct → Nano"). Only the logged-in
 * creator's accounts; only counts within YouTube's 30-day storage limit; no
 * channel ids or other platform data.
 */
@Controller("creator/social-observations")
@UseGuards(JwtAuthGuard)
export class CreatorObservationController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get("mine")
  async mine(@Req() req: any) {
    const profileType =
      PROFILE_TYPE[String(req?.user?.role || "").toLowerCase()];
    const profileId = String(req?.user?.userId || "");
    if (!profileType || !profileId) return { accounts: [] };
    const now = Date.now();
    const profile: any = Types.ObjectId.isValid(profileId)
      ? await this.connection
          .collection(COLLECTION[profileType])
          .findOne(
            { _id: new Types.ObjectId(profileId) },
            { projection: { socialMedia: 1 } },
          )
      : null;
    const entries = new Map<string, any>(
      (Array.isArray(profile?.socialMedia) ? profile.socialMedia : []).map(
        (e: any) => [String(e?.socialAccountId), e],
      ),
    );
    const [observations, verifications] = await Promise.all([
      this.connection
        .collection("social_account_observations")
        .find(
          { profileType, profileId, platformKey: "youtube" },
          {
            projection: {
              _id: 0,
              socialAccountId: 1,
              platformKey: 1,
              source: 1,
              status: 1,
              observedHandle: 1,
              externalAccountId: 1,
              observedFollowersCount: 1,
              capturedAt: 1,
              lastError: 1,
              failureCount: 1,
              handleChangedTo: 1,
            },
          },
        )
        .toArray(),
      this.connection
        .collection("social_account_verifications")
        .find(
          { profileType, profileId, tierAutoAppliedAt: { $exists: true } },
          { projection: { _id: 0, socialAccountId: 1, tierAutoAppliedAt: 1 } },
        )
        .toArray(),
    ]);
    const autoAt = new Map(
      verifications.map((v) => [
        String(v.socialAccountId),
        v.tierAutoAppliedAt,
      ]),
    );
    const accounts: any[] = [];
    for (const o of observations) {
      const entry = entries.get(String(o.socialAccountId)) ?? null;
      if (!entry) continue; // an account the creator removed
      const base = {
        socialAccountId: String(o.socialAccountId),
        platform: "YouTube",
        declaredTier: String(entry.tier ?? ""),
        handle: String(entry.handle ?? ""),
        tierAutoUpdatedAt: autoAt.get(String(o.socialAccountId)) ?? null,
      };
      // Not found: nothing to show but the request to check the handle.
      if (
        o.status === "failed" &&
        NOT_FOUND_REASONS.includes(String(o.lastError)) &&
        Number(o.failureCount || 0) >= NOT_FOUND_AFTER_FAILURES
      ) {
        accounts.push({
          ...base,
          subscribers: null,
          capturedAt: null,
          tier: null,
          newHandle: null,
          status: "not_found" as YoutubeCheckStatus,
        });
        continue;
      }
      const fresh =
        o.capturedAt &&
        now - new Date(o.capturedAt).getTime() <=
          AUTO_TIER.maxAgeDays * DAY_MS &&
        Number(o.observedFollowersCount) > 0;
      const renamedTo =
        typeof o.handleChangedTo === "string" &&
        o.handleChangedTo &&
        handleKey(o.handleChangedTo) !== handleKey(entry.handle)
          ? o.handleChangedTo
          : null;
      if (!fresh && !renamedTo) continue;
      const observedTier = fresh
        ? tierForFollowers(o.observedFollowersCount)
        : null;
      accounts.push({
        ...base,
        subscribers: fresh ? Number(o.observedFollowersCount) : null,
        capturedAt: fresh ? o.capturedAt : null,
        tier: observedTier?.label ?? null,
        newHandle: renamedTo,
        status: renamedTo
          ? ("handle_renamed" as YoutubeCheckStatus)
          : checkStatus(entry, o, observedTier?.key ?? null),
      });
    }
    return { accounts };
  }
}

function checkStatus(
  entry: any,
  observation: any,
  observedTierKey: string | null,
): YoutubeCheckStatus {
  if (!entry) return "check_handle";
  const handle = buildSocialAccountComparison(
    entry,
    null,
    observationView(entry, observation),
  ).comparison.handle.status;
  if (handle !== "match") return "check_handle";
  return observedTierKey && tierIdentity(entry.tier) !== observedTierKey
    ? "please_update"
    : "matches";
}

/** Handles compare without "@", spaces or case. */
function handleKey(handle: unknown): string {
  return (typeof handle === "string" ? handle : "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}
