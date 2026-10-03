import { buildSyncSnapshot, hashSnapshot } from "./collaboration-score-sync.util";
import { CollectedPlatformData } from "./collectors/collector.interface";

function makeCollected(overrides: Partial<CollectedPlatformData> = {}): CollectedPlatformData {
  return {
    platform: "YouTube",
    method: "API",
    handle: "creator",
    followersOrSubscribers: 1000,
    recentPosts: [
      { title: "Video A", description: "", publishedAt: new Date("2026-07-01"), views: 100, likes: 10, comments: 1 },
    ],
    collectedAt: new Date("2026-07-15"),
    raw: { bio: "hello" },
    confidence: 90,
    confidenceReason: "",
    ...overrides,
  };
}

describe("collaboration-score-sync.util", () => {
  describe("hashSnapshot", () => {
    it("is stable regardless of the snapshot object's key order", () => {
      const a = { handle: "x", followersOrSubscribers: 1, postsCount: 0, postTitles: [], latestPostAt: null, raw: { b: 1, a: 2 } };
      const b = { raw: { a: 2, b: 1 }, latestPostAt: null, postTitles: [], postsCount: 0, followersOrSubscribers: 1, handle: "x" };

      expect(hashSnapshot(a)).toBe(hashSnapshot(b));
    });

    it("differs when followersOrSubscribers changes", () => {
      const snap1 = buildSyncSnapshot(makeCollected({ followersOrSubscribers: 1000 }));
      const snap2 = buildSyncSnapshot(makeCollected({ followersOrSubscribers: 1001 }));

      expect(hashSnapshot(snap1)).not.toBe(hashSnapshot(snap2));
    });

    it("differs when post titles change", () => {
      const snap1 = buildSyncSnapshot(makeCollected());
      const snap2 = buildSyncSnapshot(
        makeCollected({
          recentPosts: [{ title: "Video B", description: "", publishedAt: new Date("2026-07-01"), views: 100, likes: 10, comments: 1 }],
        }),
      );

      expect(hashSnapshot(snap1)).not.toBe(hashSnapshot(snap2));
    });

    it("differs when raw payload changes (e.g. bio edited via the connected platform)", () => {
      const snap1 = buildSyncSnapshot(makeCollected({ raw: { bio: "hello" } }));
      const snap2 = buildSyncSnapshot(makeCollected({ raw: { bio: "goodbye" } }));

      expect(hashSnapshot(snap1)).not.toBe(hashSnapshot(snap2));
    });

    it("is identical for two independently-built but equivalent snapshots", () => {
      const snap1 = buildSyncSnapshot(makeCollected());
      const snap2 = buildSyncSnapshot(makeCollected());

      expect(hashSnapshot(snap1)).toBe(hashSnapshot(snap2));
    });
  });

  describe("buildSyncSnapshot", () => {
    it("caps postTitles at 10 and reports the true postsCount", () => {
      const posts = Array.from({ length: 15 }, (_, i) => ({
        title: `Video ${i}`,
        description: "",
        publishedAt: new Date(2026, 0, i + 1),
        views: 10,
        likes: 1,
        comments: 0,
      }));
      const snapshot = buildSyncSnapshot(makeCollected({ recentPosts: posts }));

      expect(snapshot.postsCount).toBe(15);
      expect(snapshot.postTitles).toHaveLength(10);
    });

    it("uses the first (most recent) post's publishedAt as latestPostAt, null when there are no posts", () => {
      const withPosts = buildSyncSnapshot(makeCollected());
      expect(withPosts.latestPostAt).toBe(new Date("2026-07-01").toISOString());

      const withoutPosts = buildSyncSnapshot(makeCollected({ recentPosts: [] }));
      expect(withoutPosts.latestPostAt).toBeNull();
    });
  });
});
