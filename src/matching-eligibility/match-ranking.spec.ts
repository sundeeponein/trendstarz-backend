import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { toEligibilityRow } from "./campaign-eligibility";
import { EligibilityResult, evaluateEligibility } from "./eligibility";
import { MatchingEligibilityService } from "./matching-eligibility.service";
import {
  ACTIVITY_BUCKET_ORDER,
  RankingEntry,
  activityBucket,
  rankEligibleCreators,
} from "./match-ranking";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date("2026-10-04T12:00:00.000Z");
const daysAgo = (d: number) => new Date(AS_OF.getTime() - d * DAY);

type Pair = [platform: string, contentType: string];

const rawCreator = (
  id: string,
  {
    pairs = [["Instagram", "Reel"]] as Pair[],
    categories = ["Fashion"],
    ...over
  }: { pairs?: Pair[]; categories?: string[]; [k: string]: any } = {},
) => {
  const byPlatform = new Map<string, string[]>();
  for (const [p, ct] of pairs)
    byPlatform.set(p, [...(byPlatform.get(p) || []), ct]);
  return {
    _id: id,
    name: `Creator ${id}`,
    username: `user_${id}`,
    publicId: `TSZ-${id}`,
    status: "accepted",
    isDeleted: false,
    isEmailVerified: true,
    isMobileVerified: true,
    verificationStatus: "approved",
    profileImages: [{ url: "x" }],
    location: { state: "Telangana", district: "Hyderabad" },
    categories,
    languages: ["Telugu"],
    socialMedia: [...byPlatform].map(([platform, cts], i) => ({
      socialAccountId: `64b00000000000000000000${i}`,
      platform,
      handle: `h_${id}`,
      tier: "Micro",
      contentTypes: cts.map((name) => ({ name, enabled: true, price: 500 })),
    })),
    lastLoginAt: null,
    lastOpenedAt: null,
    ...over,
  };
};

const rawCampaign = ({
  pairs = [["Instagram", "Reel"]] as Pair[],
  categories = ["Fashion"],
  ...over
}: { pairs?: Pair[]; categories?: string[]; [k: string]: any } = {}) => ({
  _id: "camp-1",
  title: "Festive Reels",
  status: "active",
  campaignMode: "invite_only",
  ownerType: "brand",
  inviteRecipientRole: "influencer",
  platforms: [...new Set(pairs.map(([p]) => p))],
  categories,
  socialMedia: pairs.map(([platform, name]) => ({
    platform,
    contentTypes: [{ name, enabled: true, price: 1000 }],
  })),
  ...over,
});

const campaignOf = (over: Parameters<typeof rawCampaign>[0] = {}) =>
  normalizeCampaignMatchInput(rawCampaign(over));

const entry = (
  campaign: ReturnType<typeof campaignOf>,
  raw: Record<string, any>,
): RankingEntry => {
  const creator = normalizeCreatorMatchInput(raw, "Influencer");
  return { creator, result: evaluateEligibility(campaign, creator) };
};

const rank = (
  campaign: ReturnType<typeof campaignOf>,
  raws: Record<string, any>[],
  asOf = AS_OF,
) =>
  rankEligibleCreators(
    campaign,
    raws.map((r) => entry(campaign, r)),
    asOf,
  );

const only = (
  campaign: ReturnType<typeof campaignOf>,
  raw: Record<string, any>,
) => {
  const out = rank(campaign, [raw]);
  expect(out).toHaveLength(1);
  return out[0];
};

// ── Rule 1: platform/content coverage ───────────────────────────────────────

describe("Stage 3C-1 ranking — platform/content coverage", () => {
  it("1/1: the single campaign pair is fully covered", () => {
    const r = only(campaignOf(), rawCreator("a"));
    expect(r.platformContent).toEqual({
      matched: ["instagram:reel"],
      total: 1,
    });
    expect(r.rankingReasons[0]).toBe(
      "Matches all campaign platform/content options",
    );
  });

  it("1/2 and 2/2 are measured against the campaign's pairs", () => {
    const c = campaignOf({
      pairs: [
        ["Instagram", "Reel"],
        ["YouTube", "Video"],
      ],
    });
    const half = only(c, rawCreator("a"));
    expect(half.platformContent).toEqual({
      matched: ["instagram:reel"],
      total: 2,
    });
    expect(half.rankingReasons[0]).toBe(
      "Matches 1 of 2 campaign platform/content options",
    );
    const full = only(
      c,
      rawCreator("b", {
        pairs: [
          ["Instagram", "Reel"],
          ["YouTube", "Video"],
        ],
      }),
    );
    expect(full.platformContent.matched).toEqual([
      "instagram:reel",
      "youtube:video",
    ]);
    expect(full.platformContent.total).toBe(2);
  });

  it("1/3 vs 3/3 (spec example): full coverage ranks first", () => {
    const c = campaignOf({
      pairs: [
        ["Instagram", "Reel"],
        ["Instagram", "Story (24h)"],
        ["YouTube", "Video"],
      ],
    });
    const out = rank(c, [
      rawCreator("a"),
      rawCreator("b", {
        pairs: [
          ["Instagram", "Reel"],
          ["Instagram", "Story (24h)"],
          ["YouTube", "Video"],
        ],
      }),
    ]);
    expect(out.map((r) => [r.creatorId, r.rank])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    expect(out[1].rankingReasons[0]).toBe(
      "Matches 1 of 3 campaign platform/content options",
    );
  });

  it("extra unrelated creator pairs never increase coverage", () => {
    const c = campaignOf();
    const plain = only(c, rawCreator("a"));
    const extra = only(
      c,
      rawCreator("b", {
        pairs: [
          ["Instagram", "Reel"],
          ["Instagram", "Story (24h)"],
          ["YouTube", "Video"],
          ["YouTube", "Shorts"],
          ["Facebook", "Post"],
        ],
      }),
    );
    expect(extra.platformContent).toEqual(plain.platformContent);
  });

  it("duplicate campaign pairs are counted once", () => {
    const c = campaignOf({
      pairs: [
        ["Instagram", "Reel"],
        ["instagram", "reel"],
      ],
    });
    expect(c.contentTypes).toEqual(["instagram:reel"]);
    expect(only(c, rawCreator("a")).platformContent).toEqual({
      matched: ["instagram:reel"],
      total: 1,
    });
  });

  it("canonical platform/content variants match through the Stage 3B keys", () => {
    const c = campaignOf({ pairs: [["Instagram", "Story (24h)"]] });
    const r = only(
      c,
      rawCreator("a", { pairs: [[" instagram ", "  STORY   (24h) "]] }),
    );
    expect(r.platformContent).toEqual({
      matched: ["instagram:story"],
      total: 1,
    });
  });

  it("no campaign pairs: deterministic neutral key, no division by zero", () => {
    const c = campaignOf({ pairs: [], platforms: [] });
    expect(c.contentTypes).toEqual([]);
    const out = rank(c, [rawCreator("b"), rawCreator("a")]);
    expect(out.map((r) => r.creatorId)).toEqual(["a", "b"]);
    for (const r of out) {
      expect(r.platformContent).toEqual({ matched: [], total: 0 });
      expect(r.rankingReasons[0]).toBe(
        "Campaign has no platform/content options to compare; treated as neutral.",
      );
    }
  });
});

// ── Rule 2: category coverage ───────────────────────────────────────────────

describe("Stage 3C-1 ranking — category coverage", () => {
  const four = ["Fashion", "Tech", "Food", "Travel"];

  it("1/1", () => {
    const r = only(campaignOf(), rawCreator("a"));
    expect(r.category).toEqual({ matched: ["Fashion"], total: 1 });
    expect(r.rankingReasons[1]).toBe("Matches all campaign categories");
  });

  it("2/4 and 4/4 (spec example), 4/4 ranks first", () => {
    const c = campaignOf({ categories: four });
    const out = rank(c, [
      rawCreator("a", { categories: ["Fashion", "Tech"] }),
      rawCreator("b", { categories: four }),
    ]);
    expect(out.map((r) => [r.creatorId, r.category.matched.length])).toEqual([
      ["b", 4],
      ["a", 2],
    ]);
    expect(out[1].rankingReasons[1]).toBe("Matches 2 of 4 campaign categories");
  });

  it("extra and oversized (legacy 19) creator category lists never inflate coverage", () => {
    const c = campaignOf({ categories: four });
    const legacy19 = [
      "Fashion",
      ...Array.from({ length: 18 }, (_, i) => `Unrelated ${i}`),
    ];
    const out = rank(c, [
      rawCreator("c", { categories: legacy19 }),
      rawCreator("a", { categories: ["Fashion", "Tech"] }),
    ]);
    const legacy = out.find((r) => r.creatorId === "c")!;
    expect(legacy.category).toEqual({ matched: ["Fashion"], total: 4 });
    expect(out.map((r) => r.creatorId)).toEqual(["a", "c"]);
  });

  it("matched count never exceeds the campaign count", () => {
    const c = campaignOf({ categories: ["Fashion", "Tech"] });
    const r = only(
      c,
      rawCreator("a", {
        categories: ["Fashion", "FASHION", "fashion ", "Tech", "Food"],
      }),
    );
    expect(r.category.matched.length).toBeLessThanOrEqual(r.category.total);
    expect(r.category).toEqual({ matched: ["Fashion", "Tech"], total: 2 });
  });

  it("duplicate campaign categories are counted once", () => {
    const c = campaignOf({ categories: ["Fashion", "fashion", " Fashion "] });
    expect(only(c, rawCreator("a")).category).toEqual({
      matched: ["Fashion"],
      total: 1,
    });
  });

  it("casing/spacing use the Stage 3B comparison", () => {
    const c = campaignOf({ categories: ["Fashion", "Food"] });
    const r = only(c, rawCreator("a", { categories: ["  FASHION ", "food"] }));
    expect(r.category).toEqual({ matched: ["Fashion", "Food"], total: 2 });
  });

  it("no campaign categories: deterministic neutral key, no division by zero", () => {
    const c = campaignOf({ categories: [] });
    const out = rank(c, [
      rawCreator("b", { categories: ["Fashion", "Tech"] }),
      rawCreator("a", { categories: ["Food"] }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(["a", "b"]);
    for (const r of out) {
      expect(r.category).toEqual({ matched: [], total: 0 });
      expect(r.rankingReasons[1]).toBe(
        "Campaign has no category requirement; treated as neutral.",
      );
    }
  });

  it("photographer-owned campaigns use targetCreatorCategories (same as eligibility)", () => {
    const c = campaignOf({
      ownerType: "photographer",
      categories: ["Wedding"],
      targetTiers: ["Fashion", "Food"],
    });
    const r = only(c, rawCreator("a"));
    expect(r.category).toEqual({ matched: ["Fashion"], total: 2 });
  });
});

// ── Rule 3: activity ────────────────────────────────────────────────────────

describe("Stage 3C-1 ranking — activity buckets (boundaries on elapsed time, upper bound inclusive)", () => {
  const cases: Array<[string, Date | null, string, number | null]> = [
    ["today (same instant)", AS_OF, "within_7_days", 0],
    ["exactly 7 days", daysAgo(7), "within_7_days", 7],
    [
      "7 days + 1 ms",
      new Date(daysAgo(7).getTime() - 1),
      "within_8_30_days",
      7,
    ],
    ["exactly 8 days", daysAgo(8), "within_8_30_days", 8],
    ["exactly 30 days", daysAgo(30), "within_8_30_days", 30],
    ["exactly 31 days", daysAgo(31), "within_31_90_days", 31],
    ["exactly 90 days", daysAgo(90), "within_31_90_days", 90],
    ["exactly 91 days", daysAgo(91), "over_90_days", 91],
    ["missing", null, "unknown", null],
    ["invalid date", new Date("not a date"), "unknown", null],
    ["future (malformed)", new Date(AS_OF.getTime() + DAY), "unknown", null],
  ];
  it.each(cases)("%s", (_label, at, bucket, days) => {
    expect(activityBucket(at, AS_OF)).toEqual({
      bucket,
      daysSinceActive: days,
    });
  });

  it("uses the matching-input activity semantics: lastLoginAt, else lastOpenedAt", () => {
    const c = campaignOf();
    const loginOnly = only(c, rawCreator("a", { lastLoginAt: daysAgo(3) }));
    expect(loginOnly.activity.bucket).toBe("within_7_days");
    const openedOnly = only(c, rawCreator("a", { lastOpenedAt: daysAgo(20) }));
    expect(openedOnly.activity.bucket).toBe("within_8_30_days");
    // Both present: lastLoginAt wins (existing normalizeCreatorMatchInput rule),
    // even when lastOpenedAt is more recent.
    const both = only(
      c,
      rawCreator("a", { lastLoginAt: daysAgo(40), lastOpenedAt: daysAgo(2) }),
    );
    expect(both.activity).toEqual({
      bucket: "within_31_90_days",
      lastActiveAt: daysAgo(40).toISOString(),
      daysSinceActive: 40,
    });
  });

  it("reasons per bucket; unknown and future are neutral", () => {
    const c = campaignOf();
    const reason = (over: Record<string, any>) =>
      only(c, rawCreator("a", over)).rankingReasons[2];
    expect(reason({ lastLoginAt: daysAgo(1) })).toBe(
      "Active within the last 7 days",
    );
    expect(reason({ lastLoginAt: daysAgo(15) })).toBe(
      "Active within the last 8–30 days",
    );
    expect(reason({ lastLoginAt: daysAgo(60) })).toBe(
      "Active within the last 31–90 days",
    );
    expect(reason({ lastLoginAt: daysAgo(200) })).toBe(
      "Last active more than 90 days ago",
    );
    expect(reason({})).toBe(
      "Recent activity is unavailable; treated as neutral.",
    );
    expect(reason({ lastLoginAt: new Date(AS_OF.getTime() + DAY) })).toBe(
      "Recorded activity is later than the ranking time; treated as neutral.",
    );
  });

  it("UNKNOWN is neutral: ties with 31–90 days, above 91+, below recent activity", () => {
    expect(ACTIVITY_BUCKET_ORDER.unknown).toBe(
      ACTIVITY_BUCKET_ORDER.within_31_90_days,
    );
    const out = rank(campaignOf(), [
      rawCreator("old", { lastLoginAt: daysAgo(120) }),
      rawCreator("unk"),
      rawCreator("mid", { lastLoginAt: daysAgo(45) }),
      rawCreator("new", { lastLoginAt: daysAgo(2) }),
      rawCreator("fut", { lastLoginAt: new Date(AS_OF.getTime() + DAY) }),
    ]);
    // new → (fut, mid, unk tie on the neutral key → id order) → old
    expect(out.map((r) => r.creatorId)).toEqual([
      "new",
      "fut",
      "mid",
      "unk",
      "old",
    ]);
  });

  it("every creator is bucketed against the same asOf", () => {
    const c = campaignOf();
    const raws = [rawCreator("a", { lastLoginAt: daysAgo(6) })];
    expect(rank(c, raws, AS_OF)[0].activity.bucket).toBe("within_7_days");
    expect(
      rank(c, raws, new Date(AS_OF.getTime() + 2 * DAY))[0].activity.bucket,
    ).toBe("within_8_30_days");
  });

  it("rejects an invalid asOf instead of guessing a clock", () => {
    expect(() => rank(campaignOf(), [rawCreator("a")], new Date("x"))).toThrow(
      /asOf/,
    );
  });
});

// ── Lexicographic ordering ─────────────────────────────────────────────────

describe("Stage 3C-1 ranking — lexicographic order", () => {
  const c = campaignOf({
    pairs: [
      ["Instagram", "Reel"],
      ["YouTube", "Video"],
    ],
    categories: ["Fashion", "Tech", "Food", "Travel"],
  });
  const both: Pair[] = [
    ["Instagram", "Reel"],
    ["YouTube", "Video"],
  ];

  it("platform/content beats category and activity", () => {
    const out = rank(c, [
      rawCreator("a", {
        categories: ["Fashion", "Tech", "Food", "Travel"],
        lastLoginAt: daysAgo(0),
      }),
      rawCreator("z", { pairs: both, lastLoginAt: daysAgo(300) }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(["z", "a"]);
  });

  it("category beats activity", () => {
    const out = rank(c, [
      rawCreator("a", { pairs: both, lastLoginAt: daysAgo(0) }),
      rawCreator("z", {
        pairs: both,
        categories: ["Fashion", "Tech"],
        lastLoginAt: daysAgo(300),
      }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(["z", "a"]);
  });

  it("activity beats creator id", () => {
    const out = rank(c, [
      rawCreator("a", { pairs: both, lastLoginAt: daysAgo(100) }),
      rawCreator("z", { pairs: both, lastLoginAt: daysAgo(1) }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(["z", "a"]);
  });

  it("creator id is the final tie-break (ascending), ranks are 1..n", () => {
    const ids = [
      "64b0000000000000000000c3",
      "64b0000000000000000000a1",
      "64b0000000000000000000b2",
    ];
    const out = rank(
      c,
      ids.map((id) => rawCreator(id, { lastLoginAt: daysAgo(10) })),
    );
    expect(out.map((r) => [r.rank, r.creatorId])).toEqual([
      [1, "64b0000000000000000000a1"],
      [2, "64b0000000000000000000b2"],
      [3, "64b0000000000000000000c3"],
    ]);
  });

  it("produces no numeric score anywhere", () => {
    const [r] = rank(c, [rawCreator("a", { pairs: both })]);
    expect(Object.keys(r).sort()).toEqual([
      "activity",
      "category",
      "creatorId",
      "platformContent",
      "rank",
      "rankingReasons",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/score|weight|\/100/i);
  });
});

// ── Eligibility gate ───────────────────────────────────────────────────────

describe("Stage 3C-1 ranking — only PASS creators are ranked", () => {
  const c = campaignOf({ languages: ["Telugu"] });
  const pass = rawCreator("p");
  const fail = rawCreator("f", { languages: ["Hindi"] });
  const unknown = rawCreator("u", { languages: [] });

  it("PASS ranked, FAIL and UNKNOWN unranked", () => {
    const entries = [pass, fail, unknown].map((r) => entry(c, r));
    expect(entries.map((e) => e.result.overall)).toEqual([
      "PASS",
      "FAIL",
      "UNKNOWN",
    ]);
    const out = rankEligibleCreators(c, entries, AS_OF);
    expect(out.map((r) => [r.creatorId, r.rank])).toEqual([["p", 1]]);
  });

  it("a non-PASS result is never ranked even if its creator would rank first", () => {
    const strong = rawCreator("a", { lastLoginAt: daysAgo(0) });
    const e = entry(c, strong);
    const tampered: EligibilityResult = {
      ...e.result,
      requirements: {
        ...e.result.requirements,
        location: { status: "FAIL", reason: "x", configured: true },
      },
    };
    expect(
      rankEligibleCreators(c, [{ ...e, result: tampered }], AS_OF),
    ).toEqual([]);
  });

  it("ranking does not mutate eligibility results or creator inputs", () => {
    const entries = [pass, fail, unknown].map((r) => entry(c, r));
    const before = JSON.stringify(entries);
    rankEligibleCreators(c, entries, AS_OF);
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("rejects mismatched or duplicate inputs instead of silently ranking them", () => {
    const e = entry(c, pass);
    const other = entry(c, rawCreator("q"));
    expect(() =>
      rankEligibleCreators(
        c,
        [{ result: e.result, creator: other.creator }],
        AS_OF,
      ),
    ).toThrow(/mismatch/);
    expect(() => rankEligibleCreators(c, [e, e], AS_OF)).toThrow(/duplicate/);
    expect(() =>
      rankEligibleCreators(campaignOf({ _id: "camp-2" }), [e], AS_OF),
    ).toThrow(/another campaign/);
  });
});

// ── Determinism & purity ───────────────────────────────────────────────────

describe("Stage 3C-1 ranking — determinism and purity", () => {
  const c = campaignOf({
    pairs: [
      ["Instagram", "Reel"],
      ["Instagram", "Story (24h)"],
      ["YouTube", "Video"],
    ],
    categories: ["Fashion", "Tech", "Food", "Travel"],
  });
  const raws = Array.from({ length: 40 }, (_, i) => {
    const pairs: Pair[] = [
      ["Instagram", "Reel"],
      ["Instagram", "Story (24h)"],
      ["YouTube", "Video"],
    ].slice(0, 1 + (i % 3)) as Pair[];
    const cats = ["Fashion", "Tech", "Food", "Travel"].slice(0, 1 + (i % 4));
    const id = `64b0${String((i * 7919) % 100000).padStart(20, "0")}`;
    return rawCreator(id, {
      pairs,
      categories: cats,
      lastLoginAt: i % 5 === 0 ? null : daysAgo((i * 13) % 140),
    });
  });

  it("identical input + asOf → identical order, ranks and reasons (repeated runs)", () => {
    const first = JSON.stringify(rank(c, raws));
    for (let i = 0; i < 25; i++)
      expect(JSON.stringify(rank(c, raws))).toBe(first);
  });

  it("input array order does not affect the result", () => {
    const base = JSON.stringify(rank(c, raws));
    expect(JSON.stringify(rank(c, [...raws].reverse()))).toBe(base);
    expect(
      JSON.stringify(rank(c, [...raws.slice(17), ...raws.slice(0, 17)])),
    ).toBe(base);
  });

  it("ranks form 1..n with no gaps and respect every rule pairwise", () => {
    const out = rank(c, raws);
    expect(out.map((r) => r.rank)).toEqual(out.map((_, i) => i + 1));
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1];
      const b = out[i];
      const key = (r: typeof a) => [
        r.platformContent.matched.length,
        r.category.matched.length,
        -ACTIVITY_BUCKET_ORDER[r.activity.bucket],
      ];
      const [ka, kb] = [key(a), key(b)];
      const cmp = ka.findIndex((v, j) => v !== kb[j]);
      if (cmp === -1) expect(a.creatorId < b.creatorId).toBe(true);
      else expect(ka[cmp]).toBeGreaterThan(kb[cmp]);
    }
  });

  it("the ranking module has no clock, randomness, DB, network or AI dependency", () => {
    const src = readFileSync(join(__dirname, "match-ranking.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now|new Date\(\s*\)|Math\.random|\$rand/);
    expect(code).not.toMatch(
      /mongoose|@nestjs|InjectModel|http|fetch\(|anthropic|openai/i,
    );
    expect(code).not.toMatch(
      /trendScore|followers|isPremium|profileCompletion|tier/i,
    );
  });
});

// ── Service integration (admin eligibility endpoint) ───────────────────────

describe("Stage 3C-1 admin eligibility list — ranking attached, nothing else changes", () => {
  const c = campaignOf({
    pairs: [
      ["Instagram", "Reel"],
      ["YouTube", "Video"],
    ],
    languages: ["Telugu"],
  });
  // The service captures its own request-time asOf (the real clock), so these
  // fixtures are relative to "now", never to the fixed AS_OF used above.
  const loadedAt = Date.now();
  const recently = (d: number) => new Date(loadedAt - d * DAY);
  const raws = [
    rawCreator("b", { lastLoginAt: recently(100) }),
    rawCreator("a", {
      pairs: [
        ["Instagram", "Reel"],
        ["YouTube", "Video"],
      ],
      lastLoginAt: recently(100),
    }),
    rawCreator("c", { lastLoginAt: recently(2) }),
    rawCreator("f", { languages: ["Hindi"] }),
    rawCreator("u", { languages: [] }),
  ];
  const display = (r: any) => ({
    name: r.name,
    username: r.username,
    publicId: r.publicId,
  });

  const run = async (query: Record<string, unknown> = { status: "all" }) => {
    const inputs = {
      forCampaignWithTitle: jest
        .fn()
        .mockResolvedValue({ input: c, title: "Festive Reels" }),
      forAllCreators: jest.fn().mockResolvedValue(
        raws.map((r) => ({
          input: normalizeCreatorMatchInput(r, "Influencer"),
          display: display(r),
        })),
      ),
    };
    // Only read methods exist on the mocks: any write/notify/event call would throw.
    const invites = {
      invitedRecipientIds: jest.fn().mockResolvedValue(new Set(["c", "f"])),
    };
    const list = await new MatchingEligibilityService(
      inputs as any,
      invites as any,
    ).evaluateCampaign("camp-1", query);
    return { list, inputs, invites };
  };

  it("PASS rows get rank + reasons; FAIL/UNKNOWN rows stay unranked", async () => {
    const { list } = await run();
    const by = new Map(list.rows.map((r) => [r.creatorId, r]));
    expect([...by].map(([id, r]) => [id, r.overall, r.rank])).toEqual([
      ["a", "PASS", 1],
      ["b", "PASS", 3],
      ["c", "PASS", 2],
      ["u", "UNKNOWN", null],
      ["f", "FAIL", null],
    ]);
    expect(by.get("a")!.rankingReasons).toEqual([
      "Matches all campaign platform/content options",
      "Matches all campaign categories",
      "Last active more than 90 days ago",
    ]);
    expect(by.get("c")!.rankingReasons[0]).toBe(
      "Matches 1 of 2 campaign platform/content options",
    );
    for (const id of ["u", "f"]) {
      expect(by.get(id)!.rankingReasons).toEqual([]);
      expect(by.get(id)!.rankingEvidence).toBeNull();
    }
    expect(by.get("a")!.rankingEvidence).toEqual({
      platformContent: {
        matched: ["instagram:reel", "youtube:video"],
        total: 2,
      },
      category: { matched: ["Fashion"], total: 1 },
      activity: {
        bucket: "over_90_days",
        lastActiveAt: recently(100).toISOString(),
        daysSinceActive: Math.floor(
          (Date.parse(list.ranking.asOf) - recently(100).getTime()) / DAY,
        ),
      },
    });
  });

  it("returns one request-level asOf and the rule order", async () => {
    const before = Date.now();
    const { list } = await run();
    const asOf = Date.parse(list.ranking.asOf);
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
    expect(list.ranking.rankedCount).toBe(3);
    expect(list.ranking.order).toHaveLength(4);
    // Every PASS row's daysSinceActive is consistent with that single asOf.
    const a = list.rows.find((r) => r.creatorId === "a")!;
    expect(a.rankingEvidence!.activity.daysSinceActive).toBe(
      Math.floor((asOf - recently(100).getTime()) / DAY),
    );
  });

  it("rank is global across PASS creators, independent of filters and paging", async () => {
    const { list } = await run({ status: "PASS", pageSize: 1, page: 2 });
    expect(list.rows.map((r) => [r.creatorId, r.rank])).toEqual([["b", 3]]);
    expect(list.ranking.rankedCount).toBe(3);
  });

  it("eligibility, invited, invitable and row order are exactly the 3B values", async () => {
    const { list } = await run();
    // Re-derive the pre-3C-1 rows independently: no ranking passed in.
    const invited = new Set(["c", "f"]);
    const legacy = raws.map((r) =>
      toEligibilityRow(
        evaluateEligibility(c, normalizeCreatorMatchInput(r, "Influencer")),
        display(r),
        invited.has(String(r._id)),
      ),
    );
    const legacyById = new Map(legacy.map((r) => [r.creatorId, r]));
    // Row order is unchanged: PASS → UNKNOWN → FAIL, then name (not rank).
    expect(list.rows.map((r) => r.creatorId)).toEqual([
      "a",
      "b",
      "c",
      "u",
      "f",
    ]);
    for (const row of list.rows) {
      const l = legacyById.get(row.creatorId)!;
      expect(row.overall).toBe(l.overall);
      expect(row.requirements).toEqual(l.requirements);
      expect(row.invited).toBe(l.invited);
    }
    const byId = new Map(list.rows.map((r) => [r.creatorId, r]));
    expect(byId.get("c")).toMatchObject({
      invited: true,
      invitable: false,
      inviteBlockedReason: "Already invited to this campaign.",
    });
    expect(byId.get("a")).toMatchObject({ invited: false, invitable: true });
    expect(byId.get("f")).toMatchObject({ invitable: false });
    expect(byId.get("u")).toMatchObject({ invitable: false });
    expect(list.counts).toEqual({ PASS: 3, UNKNOWN: 1, FAIL: 1 });
  });

  it("reads only: one campaign read, one creator read, one invite read", async () => {
    const { inputs, invites } = await run();
    expect(inputs.forCampaignWithTitle).toHaveBeenCalledTimes(1);
    expect(inputs.forAllCreators).toHaveBeenCalledTimes(1);
    expect(invites.invitedRecipientIds).toHaveBeenCalledTimes(1);
  });
});
