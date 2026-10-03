export type CollaborationScorePlatform =
  | "YouTube"
  | "Instagram"
  | "Facebook"
  | "LinkedIn";

export type CollaborationScoreCollectionMethod = "API" | "SELF_REPORTED";

export interface CollectedPost {
  title: string;
  description: string;
  publishedAt: Date;
  views?: number;
  likes?: number;
  comments?: number;
}

export interface CollectedPlatformData {
  platform: CollaborationScorePlatform;
  method: CollaborationScoreCollectionMethod;
  handle: string;
  followersOrSubscribers: number;
  recentPosts: CollectedPost[];
  collectedAt: Date;
  raw: unknown;
  /**
   * 0-100 — how much weight this platform's data deserves. API-collected
   * platforms with rich recent-post data score high; self-reported or
   * data-sparse platforms score low. Surfaced to users so the system never
   * implies more confidence in a score than the underlying data supports.
   */
  confidence: number;
  confidenceReason: string;
}

export interface ProfileCollector {
  readonly platform: CollaborationScorePlatform;
  /**
   * `socialMediaEntry` is the profile's existing socialMedia[] sub-document
   * for this platform (handle, followersCount, and — for
   * self-reported-only platforms — selfReportedStats). `userId` lets
   * Instagram/Facebook look up a SocialOAuthConnection and pull real data
   * when the creator has connected their account; YouTube/LinkedIn ignore
   * it. Never fetches anything requiring a login the creator hasn't
   * explicitly granted.
   */
  collect(socialMediaEntry: any, userId?: string): Promise<CollectedPlatformData | null>;
}
