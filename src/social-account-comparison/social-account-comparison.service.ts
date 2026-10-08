import { Injectable } from "@nestjs/common";
import { SocialProfileType } from "../database/schemas/social-account-verification.schema";
import { SocialAccountObservationService } from "../social-account-observation/social-account-observation.service";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import { isSocialAccountId } from "../utils/social-account.util";
import {
  SocialAccountComparison,
  buildSocialAccountComparison,
} from "./social-account-comparison";

function plain(entry: unknown): Record<string, any> {
  if (!entry || typeof entry !== "object") return {};
  const e = entry as { toObject?: () => Record<string, any> };
  return typeof e.toObject === "function"
    ? e.toObject()
    : (entry as Record<string, any>);
}

/**
 * Stage 3A-3 — read-only comparison layer (admin only).
 *
 * Reads the Stage 3A-1 and 3A-2 current state through their own read methods
 * (listForProfile) and combines them with the declared entry. Never calls a
 * platform API (no observe()), never records a decision (no decide()), never
 * writes the profile.
 */
@Injectable()
export class SocialAccountComparisonService {
  constructor(
    private readonly verification: SocialAccountVerificationService,
    private readonly observation: SocialAccountObservationService,
  ) {}

  /** Every social account on a profile that has a stable socialAccountId. */
  async compareProfile(
    profileType: SocialProfileType,
    profileId: string,
    socialMedia: unknown,
  ): Promise<SocialAccountComparison[]> {
    const entries = (Array.isArray(socialMedia) ? socialMedia : [])
      .map(plain)
      .filter((e) => isSocialAccountId(e.socialAccountId));
    if (!entries.length) return [];

    const [verifications, observations] = await Promise.all([
      this.verification.listForProfile(profileType, profileId, entries),
      this.observation.listForProfile(profileType, profileId, entries),
    ]);
    const verificationById = new Map(
      verifications.map((v) => [String(v.socialAccountId), v]),
    );
    const observationById = new Map(
      observations.map((o) => [String(o.socialAccountId), o]),
    );
    return entries.map((entry) =>
      buildSocialAccountComparison(
        entry,
        verificationById.get(entry.socialAccountId) ?? null,
        observationById.get(entry.socialAccountId) ?? null,
      ),
    );
  }

  /** ONE social account (the caller has already resolved it on this profile by socialAccountId). */
  async compareAccount(
    profileType: SocialProfileType,
    profileId: string,
    entry: unknown,
  ): Promise<SocialAccountComparison> {
    const [comparison] = await this.compareProfile(profileType, profileId, [
      entry,
    ]);
    return comparison;
  }
}
