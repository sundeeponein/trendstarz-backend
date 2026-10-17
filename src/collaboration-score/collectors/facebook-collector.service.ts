import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { MetaOAuthService } from "../../meta-oauth/meta-oauth.service";
import { CollectedPlatformData, CollectedPost, ProfileCollector } from "./collector.interface";

/**
 * Real data once the creator has connected via Meta OAuth; falls back to
 * the pre-existing self-reported reading otherwise — see
 * instagram-collector.service.ts for the identical pattern/rationale.
 */
@Injectable()
export class FacebookCollectorService implements ProfileCollector {
  readonly platform = "Facebook" as const;

  constructor(
    @InjectModel("SocialOAuthConnection") private readonly connectionModel: Model<any>,
    private readonly metaOAuthService: MetaOAuthService,
  ) {}

  async collect(socialMediaEntry: any, userId?: string): Promise<CollectedPlatformData | null> {
    const handle = String(socialMediaEntry?.handle || "").trim();

    if (userId) {
      const connection: any = await this.connectionModel
        .findOne({ userId: String(userId), platform: "facebook", revokedAt: null })
        .select("+accessToken")
        .lean();
      if (connection?.facebookPageId && connection?.accessToken) {
        const collected = await this.collectViaApi(connection, handle);
        if (collected) return collected;
      }
    }

    if (!handle) return null;
    return this.collectSelfReported(socialMediaEntry, handle);
  }

  private async collectViaApi(connection: any, fallbackHandle: string): Promise<CollectedPlatformData | null> {
    const stats = await this.metaOAuthService.getFacebookPageStats(connection.facebookPageId, connection.accessToken);
    if (!stats) return null;

    // Keep the profile-edit page's "Followers" display cache fresh on every
    // real audit. The Page name itself only comes from resolveFacebookPages()
    // at connect time — rarely changes, so it isn't re-fetched here.
    try {
      await this.connectionModel.updateOne(
        { _id: connection._id },
        { $set: { followersCount: stats.followersCount } },
      );
    } catch {
      // Display-cache refresh is best-effort — never blocks the audit itself.
    }

    const recentPosts: CollectedPost[] = stats.posts.map((p) => ({
      title: "",
      description: "",
      publishedAt: p.createdAt,
      likes: p.likes,
      comments: p.comments,
    }));
    const { confidence, confidenceReason } = this.computeConfidence(recentPosts);

    return {
      platform: "Facebook",
      method: "API",
      handle: fallbackHandle || connection.facebookPageId,
      followersOrSubscribers: stats.followersCount,
      recentPosts,
      collectedAt: new Date(),
      raw: { facebookPageId: connection.facebookPageId },
      confidence,
      confidenceReason,
    };
  }

  private collectSelfReported(socialMediaEntry: any, handle: string): CollectedPlatformData {
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
        : "Analysis not available yet — connect your Facebook Page or add your stats for this platform.",
    };
  }

  private computeConfidence(recentPosts: CollectedPost[]): { confidence: number; confidenceReason: string } {
    if (recentPosts.length >= 10) {
      return { confidence: 95, confidenceReason: "Facebook Page analyzed via Meta Graph API — sufficient recent posts." };
    }
    if (recentPosts.length >= 3) {
      return { confidence: 75, confidenceReason: "Facebook Page analyzed via Meta Graph API — limited recent posts." };
    }
    if (recentPosts.length > 0) {
      return { confidence: 55, confidenceReason: "Facebook Page connected, but very few recent posts to analyze." };
    }
    return { confidence: 30, confidenceReason: "Facebook Page connected, but no recent posts available to analyze." };
  }
}
