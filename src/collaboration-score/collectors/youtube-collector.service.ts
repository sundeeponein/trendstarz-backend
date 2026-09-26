import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import {
  CollectedPlatformData,
  CollectedPost,
  ProfileCollector,
} from "./collector.interface";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;

/**
 * Real, no-login collector — the only platform where the spec's "just paste
 * a public URL" requirement is actually achievable via an official API. Uses
 * the YouTube Data API v3 with an API key only (no OAuth, no user login).
 */
@Injectable()
export class YoutubeCollectorService implements ProfileCollector {
  readonly platform = "YouTube" as const;
  private readonly logger = new Logger(YoutubeCollectorService.name);

  async collect(socialMediaEntry: any): Promise<CollectedPlatformData | null> {
    const handle = String(socialMediaEntry?.handle || "").trim();
    if (!handle) return null;

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      this.logger.warn("YOUTUBE_API_KEY not set — skipping YouTube collection");
      return null;
    }

    try {
      const channel = await this.resolveChannel(handle, apiKey);
      if (!channel) return null;

      const uploadsPlaylistId =
        channel?.contentDetails?.relatedPlaylists?.uploads;
      const recentPosts = uploadsPlaylistId
        ? await this.fetchRecentVideos(uploadsPlaylistId, apiKey)
        : [];
      const { confidence, confidenceReason } = this.computeConfidence(recentPosts);

      return {
        platform: "YouTube",
        method: "API",
        handle,
        followersOrSubscribers: Number(
          channel?.statistics?.subscriberCount || 0,
        ),
        recentPosts,
        collectedAt: new Date(),
        raw: { channelId: channel?.id, statistics: channel?.statistics },
        confidence,
        confidenceReason,
      };
    } catch (err: any) {
      this.logger.warn(
        `YouTube collection failed for handle "${handle}": ${err?.message || err}`,
      );
      return null;
    }
  }

  private computeConfidence(
    recentPosts: CollectedPost[],
  ): { confidence: number; confidenceReason: string } {
    if (recentPosts.length >= 10) {
      return { confidence: 95, confidenceReason: "Public channel analyzed via YouTube Data API — sufficient recent uploads." };
    }
    if (recentPosts.length >= 3) {
      return { confidence: 75, confidenceReason: "Public channel analyzed via YouTube Data API — limited recent uploads." };
    }
    if (recentPosts.length > 0) {
      return { confidence: 55, confidenceReason: "Public channel found, but very few recent uploads to analyze." };
    }
    return { confidence: 30, confidenceReason: "Public channel found, but no recent uploads available to analyze." };
  }

  private async resolveChannel(handle: string, apiKey: string): Promise<any> {
    const cleaned = this.normalizeHandle(handle);
    const part = "snippet,statistics,contentDetails";

    if (CHANNEL_ID_RE.test(cleaned)) {
      const byId = await this.getChannels({ id: cleaned, part, apiKey });
      if (byId) return byId;
    }

    const byHandle = await this.getChannels({
      forHandle: cleaned.startsWith("@") ? cleaned : `@${cleaned}`,
      part,
      apiKey,
    });
    if (byHandle) return byHandle;

    const byUsername = await this.getChannels({
      forUsername: cleaned.replace(/^@/, ""),
      part,
      apiKey,
    });
    if (byUsername) return byUsername;

    // Last resort: search by name/handle text and take the top channel result.
    const searchResp = await axios.get(`${YOUTUBE_API_BASE}/search`, {
      params: {
        part: "snippet",
        type: "channel",
        q: cleaned.replace(/^@/, ""),
        maxResults: 1,
        key: apiKey,
      },
    });
    const channelId = searchResp.data?.items?.[0]?.snippet?.channelId;
    if (!channelId) return null;
    return this.getChannels({ id: channelId, part, apiKey });
  }

  private async getChannels(params: {
    id?: string;
    forHandle?: string;
    forUsername?: string;
    part: string;
    apiKey: string;
  }): Promise<any> {
    const { apiKey, ...query } = params;
    const resp = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
      params: { ...query, key: apiKey },
    });
    return resp.data?.items?.[0] || null;
  }

  private async fetchRecentVideos(
    uploadsPlaylistId: string,
    apiKey: string,
    maxResults = 20,
  ): Promise<CollectedPost[]> {
    const playlistResp = await axios.get(`${YOUTUBE_API_BASE}/playlistItems`, {
      params: {
        part: "snippet",
        playlistId: uploadsPlaylistId,
        maxResults,
        key: apiKey,
      },
    });
    const items: any[] = playlistResp.data?.items || [];
    const videoIds = items
      .map((item) => item?.snippet?.resourceId?.videoId)
      .filter(Boolean);
    if (!videoIds.length) return [];

    const statsResp = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
      params: { part: "statistics", id: videoIds.join(","), key: apiKey },
    });
    const statsById = new Map<string, any>(
      (statsResp.data?.items || []).map((v: any) => [v.id, v.statistics]),
    );

    return items.map((item) => {
      const videoId = item?.snippet?.resourceId?.videoId;
      const stats = statsById.get(videoId) || {};
      // A malformed/unexpected publishedAt from the API would otherwise
      // produce an Invalid Date whose getTime() is NaN, silently poisoning
      // every downstream score calculation for this run.
      const parsedDate = new Date(item?.snippet?.publishedAt || Date.now());
      return {
        title: String(item?.snippet?.title || ""),
        description: String(item?.snippet?.description || ""),
        publishedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
        views: Number(stats.viewCount || 0),
        likes: Number(stats.likeCount || 0),
        comments: Number(stats.commentCount || 0),
      };
    });
  }

  private normalizeHandle(handle: string): string {
    // Accept a bare handle, "@handle", or a full channel/URL and reduce it
    // to the last meaningful path segment.
    const trimmed = handle.trim().replace(/\/+$/, "");
    if (!trimmed.includes("/")) return trimmed;
    const segments = trimmed.split("/").filter(Boolean);
    return segments[segments.length - 1];
  }
}
