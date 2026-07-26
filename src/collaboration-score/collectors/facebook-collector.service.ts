import { Injectable } from "@nestjs/common";
import { CollectedPlatformData, ProfileCollector } from "./collector.interface";

/**
 * PHASE D TODO: replace with a real Facebook Graph API OAuth connect flow
 * once Meta business verification is provisioned — see
 * instagram-collector.service.ts for the full rationale (same platform
 * family, same constraint). Interface/callers stay unchanged.
 */
@Injectable()
export class FacebookCollectorService implements ProfileCollector {
  readonly platform = "Facebook" as const;

  async collect(socialMediaEntry: any): Promise<CollectedPlatformData | null> {
    const handle = String(socialMediaEntry?.handle || "").trim();
    if (!handle) return null;

    const stats = socialMediaEntry?.selfReportedStats || {};
    const hasStats = stats.avgLikes != null && stats.avgComments != null;
    return {
      platform: "Facebook",
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
      confidence: hasStats ? 35 : 0,
      confidenceReason: hasStats
        ? "Self-reported by creator — not independently verified (Beta)."
        : "Analysis not available yet — creator hasn't added their stats for this platform.",
    };
  }
}
