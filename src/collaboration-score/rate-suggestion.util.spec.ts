import { ratesByPlatformFromProfile, ratesForFollowers } from "./rate-suggestion.util";

describe("rate suggestion (2026-11-15)", () => {
  it("Starter ₹100 and Nano ₹300 per Reel; Video ×1.8; Story ×0.4 but never under ₹50", () => {
    expect(ratesForFollowers(27)).toEqual({ reelPrice: 100, videoPrice: 180, storyPrice: 50 });
    expect(ratesForFollowers(100)).toEqual({ reelPrice: 100, videoPrice: 180, storyPrice: 50 });
    expect(ratesForFollowers(101)).toEqual({ reelPrice: 300, videoPrice: 540, storyPrice: 120 });
    expect(ratesForFollowers(1000)).toEqual({ reelPrice: 300, videoPrice: 540, storyPrice: 120 });
  });

  it("higher tiers are unchanged", () => {
    expect(ratesForFollowers(1001)?.reelPrice).toBe(1500);
    expect(ratesForFollowers(50_000)?.reelPrice).toBe(5000);
    expect(ratesForFollowers(500_000)?.reelPrice).toBe(20000);
    expect(ratesForFollowers(5_000_000)?.reelPrice).toBe(75000);
    expect(ratesForFollowers(0)).toBeNull();
  });

  it("per platform from each account's own tier", () => {
    const by = ratesByPlatformFromProfile([
      { platform: "YouTube", tier: "Starter (1–100)" },
      { platform: "Instagram", tier: "Micro" },
      { platform: "Facebook", tier: "" }, // no tier → no suggestion
    ]);
    expect(by.youtube.reelPrice).toBe(100);
    expect(by.instagram.reelPrice).toBe(1500);
    expect(by.facebook).toBeUndefined();
  });
});
