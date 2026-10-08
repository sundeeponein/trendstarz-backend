import { createHash } from "crypto";
import { CollectedPlatformData } from "./collectors/collector.interface";

export interface SyncSnapshot {
  handle: string;
  followersOrSubscribers: number;
  postsCount: number;
  postTitles: string[];
  latestPostAt: string | null;
  raw: unknown;
}

/**
 * What a Sync click actually diffs against the last real audit. Includes the
 * collector's full `raw` payload (not just the typed fields) so that
 * whatever a collector already captures per platform — bio, profile
 * picture, business email, banner, etc. — automatically participates in
 * change detection, without this file hardcoding a per-platform field list
 * that would go stale as collectors evolve.
 */
export function buildSyncSnapshot(collected: CollectedPlatformData): SyncSnapshot {
  const posts = Array.isArray(collected.recentPosts) ? collected.recentPosts : [];
  return {
    handle: collected.handle || "",
    followersOrSubscribers: collected.followersOrSubscribers || 0,
    postsCount: posts.length,
    postTitles: posts.slice(0, 10).map((p) => p.title || ""),
    latestPostAt: posts[0]?.publishedAt ? new Date(posts[0].publishedAt).toISOString() : null,
    raw: collected.raw ?? null,
  };
}

// Sorts object keys recursively so the hash is stable regardless of
// insertion order (JSON.stringify is otherwise key-order-sensitive).
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashSnapshot(snapshot: SyncSnapshot): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}
