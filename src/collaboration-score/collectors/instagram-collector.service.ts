import { Injectable } from "@nestjs/common";
import { CollectedPlatformData, ProfileCollector } from "./collector.interface";

/**
 * PHASE D TODO: replace this internals-only implementation with a real
 * Instagram Graph API OAuth connect flow once Meta business verification is
 * provisioned (new SocialOAuthConnection collection, authorize/callback
 * routes, token refresh). The ProfileCollector interface and every caller
 * stay unchanged — only this file's body needs to change.
 *
 * Until then: Instagram has no ToS-compliant way to pull real metrics from
 * just a public URL with no login, so this reads whatever the creator
 * self-entered on their profile (socialMedia[].selfReportedStats) and tags
 * the result unverified/self-reported.
 */
@Injectable()
export class InstagramCollectorService implements ProfileCollector {
  readonly platform = "Instagram" as const;

  async collect(socialMediaEntry: any): Promise<CollectedPlatformData | null> {
    const handle = String(socialMediaEntry?.handle || "").trim();
    if (!handle) return null;

    const stats = socialMediaEntry?.selfReportedStats || {};
    const hasStats = stats.avgLikes != null && stats.avgComments != null;
    return {
      platform: "Instagram",
      method: "SELF_REPORTED",
      handle,
      followersOrSubscribers: Number(socialMediaEntry?.followersCount || 0),
      recentPosts: [],
      collectedAt: new Date(),
      raw: {
        avgLikes: stats.avgLikes ?? null,
        avgComments: stats.avgComments ?? null,
        postFrequencyPerWeek: stats.postFrequencyPerWeek ?? null,
        lastUpdatedAt: stats.lastUpdatedAt ?? null,
      },
      // Instagram collection is not yet automated (Phase D) — never imply
      // real analysis. Confidence stays low even with self-reported stats.
      confidence: hasStats ? 35 : 0,
      confidenceReason: hasStats
        ? "Self-reported by creator — not independently verified (Beta)."
        : "Analysis not available yet — creator hasn't added their stats for this platform.",
    };
  }
}
