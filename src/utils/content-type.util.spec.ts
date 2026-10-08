import {
  canonicalContentTypeKey,
  normalizeContentType,
} from "./content-type.util";
import { canonicalPlatformKey } from "./social-account.util";

describe("canonicalPlatformKey (Stage 3B-1)", () => {
  it.each([
    ["Instagram", "instagram"],
    ["instagram", "instagram"],
    [" YouTube ", "youtube"],
    ["FACEBOOK", "facebook"],
    ["X / Twitter", "x"],
    ["Twitter", "x"],
    ["LinkedIn", "linkedin"],
  ])("%p → %p", (raw, key) => {
    expect(canonicalPlatformKey(raw)).toBe(key);
  });

  it.each(["", "   ", "Snapchat", "Pinterest", null, undefined, 42, {}])(
    "unknown/unsupported %p → null (never guessed)",
    (raw) => {
      expect(canonicalPlatformKey(raw)).toBeNull();
    },
  );
});

describe("canonicalContentTypeKey (per-platform master content types)", () => {
  it.each([
    ["Instagram", "Photo post", "photo_post"],
    ["Instagram", "Reel", "reel"],
    ["Instagram", "Story (24h)", "story"],
    ["YouTube", "Video", "video"],
    ["YouTube", "Shorts", "shorts"],
    ["Facebook", "Post", "post"],
    ["Facebook", "Reel", "reel"],
    ["LinkedIn", "Post", "post"],
    ["LinkedIn", "Video", "video"],
    ["X / Twitter", "Tweet / post", "tweet"],
    ["instagram", "  photo   POST ", "photo_post"],
  ])("%s + %p → %s", (platform, name, key) => {
    expect(canonicalContentTypeKey(platform, name)).toBe(key);
  });

  it("only clearly equivalent formats share a key across platforms", () => {
    expect(canonicalContentTypeKey("Instagram", "Reel")).toBe(
      canonicalContentTypeKey("Facebook", "Reel"),
    );
    // A Facebook post can be text/photo/video — not the same as an Instagram photo post.
    expect(canonicalContentTypeKey("Facebook", "Post")).not.toBe(
      canonicalContentTypeKey("Instagram", "Photo post"),
    );
  });

  it.each([
    ["TikTok", "Video"], // ambiguous: short-form, not a YouTube/LinkedIn video
    ["Instagram", "Shorts"], // not an Instagram content type
    ["YouTube", "Reel"],
    ["Instagram", "Carousel"],
    ["Snapchat", "Snap"],
    ["Instagram", ""],
  ])("ambiguous or unknown %s + %p → null", (platform, name) => {
    expect(canonicalContentTypeKey(platform, name)).toBeNull();
  });

  it("keeps the original values next to the canonical ones", () => {
    expect(normalizeContentType("Instagram", "Photo post")).toEqual({
      platformKey: "instagram",
      originalPlatform: "Instagram",
      originalContentType: "Photo post",
      canonicalContentTypeKey: "photo_post",
    });
    expect(normalizeContentType("TikTok", "Video")).toMatchObject({
      platformKey: "tiktok",
      originalContentType: "Video",
      canonicalContentTypeKey: null,
    });
  });
});

describe("content-type map stays within existing master data", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { KNOWN_PLATFORM_KEYS } = require("./social-account.util");
  // Master list (`socialmedias`) as inspected on 2026-10-03.
  const MASTER: Record<string, string[]> = {
    YouTube: ["Video", "Shorts"],
    Instagram: ["Photo post", "Reel", "Story (24h)"],
    Facebook: ["Post", "Reel"],
    TikTok: ["Video", "Live"],
    "X / Twitter": ["Tweet / post"],
    LinkedIn: ["Post", "Video"],
  };

  it("every master platform resolves to an existing 3A-0 platformKey (no new platforms)", () => {
    for (const name of Object.keys(MASTER)) {
      expect(KNOWN_PLATFORM_KEYS).toContain(canonicalPlatformKey(name));
    }
  });

  it("every master content type is either mapped or deliberately null — nothing outside the master list is mapped", () => {
    const deliberatelyNull = ["TikTok/Video"];
    for (const [platform, types] of Object.entries(MASTER)) {
      for (const t of types) {
        const key = canonicalContentTypeKey(platform, t);
        if (deliberatelyNull.includes(`${platform}/${t}`))
          expect(key).toBeNull();
        else expect(key).not.toBeNull();
      }
    }
  });
});
