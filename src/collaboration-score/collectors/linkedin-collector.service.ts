import { Injectable } from "@nestjs/common";
import { CollectedPlatformData, ProfileCollector } from "./collector.interface";

/**
 * PHASE D TODO: replace with a real LinkedIn OAuth connect flow once
 * business/partner verification is provisioned. LinkedIn in particular
 * actively enforces against scraping, so this self-reported stub is not a
 * shortcut to be relaxed later — it's the only compliant option until real
 * OAuth exists. Interface/callers stay unchanged.
 */
@Injectable()
export class LinkedinCollectorService implements ProfileCollector {
  readonly platform = "LinkedIn" as const;

  async collect(socialMediaEntry: any): Promise<CollectedPlatformData | null> {
    const handle = String(socialMediaEntry?.handle || "").trim();
    if (!handle) return null;

    const stats = socialMediaEntry?.selfReportedStats || {};
    const hasStats = stats.avgLikes != null && stats.avgComments != null;
    return {
      platform: "LinkedIn",
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
        ? "Limited public information — self-reported by creator, not independently verified (Beta)."
        : "Analysis not available yet — creator hasn't added their stats for this platform.",
    };
  }
}
