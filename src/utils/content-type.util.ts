import { canonicalPlatformKey } from "./social-account.util";

/**
 * Stage 3B-1 — canonical content-type keys for matching.
 *
 * Content types are defined PER PLATFORM in the `socialmedias` master list
 * (checked against production on 2026-10-03):
 *
 *   YouTube    Video, Shorts
 *   Instagram  Photo post, Reel, Story (24h)
 *   Facebook   Post, Reel
 *   LinkedIn   Post, Video
 *   X/Twitter  Tweet / post
 *   TikTok     Video, Live            (hidden in the UI)
 *
 * A key is shared across platforms ONLY where the format is clearly the same:
 * Instagram and Facebook "Reel" are both `reel`. Everything else keeps a
 * platform-specific meaning, and matching always compares (platformKey, key)
 * pairs, so e.g. Facebook "Post" is NOT equated with Instagram "Photo post"
 * (a Facebook post may be text, photo or video). TikTok "Video" is left
 * unmapped (short-form, not the same as a YouTube/LinkedIn video).
 * No fuzzy matching: an unlisted (platform, name) pair is null.
 */
const CONTENT_TYPE_MAP: Record<string, Record<string, string>> = {
  youtube: { video: "video", shorts: "shorts" },
  instagram: {
    "photo post": "photo_post",
    reel: "reel",
    "story (24h)": "story",
  },
  facebook: { post: "post", reel: "reel" },
  linkedin: { post: "post", video: "video" },
  x: { "tweet / post": "tweet" },
  tiktok: { live: "live" },
};

export const CANONICAL_CONTENT_TYPE_KEYS = [
  "video",
  "shorts",
  "photo_post",
  "reel",
  "story",
  "post",
  "tweet",
  "live",
] as const;

const normName = (v: unknown) =>
  (typeof v === "string" ? v : "").trim().toLowerCase().replace(/\s+/g, " ");

/** Canonical key for one platform's content-type name, or null when unknown/ambiguous. */
export function canonicalContentTypeKey(
  platform: unknown,
  contentTypeName: unknown,
): string | null {
  const platformKey = canonicalPlatformKey(platform);
  if (!platformKey) return null;
  return CONTENT_TYPE_MAP[platformKey]?.[normName(contentTypeName)] ?? null;
}

/** Original + canonical, so the stored value is never lost. */
export interface NormalizedContentType {
  platformKey: string | null;
  originalPlatform: string;
  originalContentType: string;
  canonicalContentTypeKey: string | null;
}

export function normalizeContentType(
  platform: unknown,
  contentTypeName: unknown,
): NormalizedContentType {
  return {
    platformKey: canonicalPlatformKey(platform),
    originalPlatform: typeof platform === "string" ? platform : "",
    originalContentType:
      typeof contentTypeName === "string" ? contentTypeName : "",
    canonicalContentTypeKey: canonicalContentTypeKey(platform, contentTypeName),
  };
}
