import {
  CANONICAL_TIERS,
  resolveTier,
  tierForFollowers,
} from "./tier-ranges.util";

describe("canonical follower tiers (Stage 3A-0)", () => {
  it("defines the six buckets with contiguous, non-overlapping ranges", () => {
    expect(
      CANONICAL_TIERS.map((t) => [t.label, t.minFollowers, t.maxFollowers]),
    ).toEqual([
      ["Starter", 1, 100],
      ["Nano", 101, 1_000],
      ["Micro", 1_001, 10_000],
      ["Mid-Tier", 10_001, 100_000],
      ["Macro", 100_001, 1_000_000],
      ["Mega / Celebrity", 1_000_001, null],
    ]);
    for (let i = 1; i < CANONICAL_TIERS.length; i++) {
      expect(CANONICAL_TIERS[i].minFollowers).toBe(
        (CANONICAL_TIERS[i - 1].maxFollowers as number) + 1,
      );
    }
  });

  it.each([
    [1, "Starter"],
    [100, "Starter"],
    [101, "Nano"],
    [1_000, "Nano"],
    [1_001, "Micro"],
    [10_000, "Micro"],
    [10_001, "Mid-Tier"],
    [37_842, "Mid-Tier"],
    [72_000, "Mid-Tier"],
    [100_000, "Mid-Tier"],
    [100_001, "Macro"],
    [1_000_000, "Macro"],
    [1_000_001, "Mega / Celebrity"],
    [25_000_000, "Mega / Celebrity"],
  ])("%d followers → %s", (followers, label) => {
    expect(tierForFollowers(followers)?.label).toBe(label);
  });

  it("returns no tier for 0, negative, or invalid counts (0 means unknown, not tiny)", () => {
    for (const v of [0, -5, NaN, null, undefined, "abc"])
      expect(tierForFollowers(v)).toBeNull();
  });

  it("fixes the old Macro/Mega overlap", () => {
    expect(tierForFollowers(2_000_000)?.key).toBe("mega");
    expect(tierForFollowers(500_000)?.key).toBe("macro");
  });

  it("resolves every stored label, including hidden Starter/Nano and old spellings", () => {
    for (const [raw, key] of [
      ["Starter", "starter"],
      ["Nano", "nano"],
      ["Micro", "micro"],
      ["Mid-Tier", "mid_tier"],
      ["mid tier", "mid_tier"],
      ["MidTier", "mid_tier"],
      ["Macro", "macro"],
      ["Mega / Celebrity", "mega"],
      ["mega celebrity", "mega"],
      ["Micro (1,001–10,000)", "micro"],
    ] as const) {
      expect(resolveTier(raw)?.key).toBe(key);
    }
    expect(resolveTier("Gold")).toBeNull();
    expect(resolveTier("")).toBeNull();
  });
});
