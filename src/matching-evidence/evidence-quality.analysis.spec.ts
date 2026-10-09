import { Types } from "mongoose";
import {
  ACTIVITY_BUCKET_ORDER,
  RankedCreator,
} from "../matching-eligibility/match-ranking";
import { normalizeCreatorMatchInput } from "../matching-inputs/matching-inputs";
import { connectedPlatformsFrom } from "../social-account-observation/platform-observers";
import {
  EvidenceQualityInput,
  MIN_SAMPLE_SIZE,
  PROPOSED,
  buildEvidenceQualityReport,
  measureCreatorData,
  measureOutcomes,
  measureRankingResolution,
  measureSocialEvidence,
  observationFreshness,
  rankingResolution,
} from "./evidence-quality.analysis";
import { EvidenceQualityService } from "./evidence-quality.service";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date("2026-10-06T12:00:00.000Z");
const daysAgo = (d: number) => new Date(AS_OF.getTime() - d * DAY);

const YT_ID = "64b0000000000000000000a1";
const IG_ID = "64b0000000000000000000a2";

const creator = (id: string, over: Record<string, any> = {}) => ({
  _id: id,
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  profileImages: [{ url: "x" }],
  location: { state: "Telangana", district: "Hyderabad" },
  categories: ["Fashion"],
  languages: ["Telugu"],
  collaborationAvailability: { enabled: true },
  lastLoginAt: daysAgo(3),
  socialMedia: [
    {
      socialAccountId: YT_ID,
      platformKey: "youtube",
      platform: "YouTube",
      handle: "@chan",
      tier: "Micro",
      contentTypes: [{ name: "Shorts", enabled: true, price: 500 }],
    },
    {
      socialAccountId: IG_ID,
      platformKey: "instagram",
      platform: "Instagram",
      handle: "insta",
      tier: "Micro",
      contentTypes: [{ name: "Reel", enabled: true, price: 1200 }],
    },
  ],
  ...over,
});

const ytObservation = (profileId: string, over: Record<string, any> = {}) => ({
  profileType: "Influencer",
  profileId,
  socialAccountId: YT_ID,
  platformKey: "youtube",
  source: "youtube",
  externalAccountId: "UCabcdefghijklmnopqrstuv",
  observedHandle: "chan",
  observedFollowersCount: 5000,
  externalUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  capturedAt: daysAgo(2),
  status: "success",
  lastError: null,
  lastAttemptAt: daysAgo(2),
  ...over,
});

const input = (
  over: Partial<EvidenceQualityInput> = {},
): EvidenceQualityInput => ({
  asOf: AS_OF,
  creators: [{ profileType: "Influencer", profile: creator("c1") }],
  verifications: [],
  observations: [],
  connections: [],
  campaigns: [],
  events: [],
  ...over,
});

describe("Stage 3D-1m — observation freshness (proposed windows)", () => {
  it.each([
    ["missing", null, "never"],
    ["invalid", "nope", "never"],
    ["future", new Date(AS_OF.getTime() + DAY), "never"],
    ["today", AS_OF, "fresh"],
    ["exactly fresh limit", daysAgo(PROPOSED.observationFreshDays), "fresh"],
    [
      "fresh limit + 1ms",
      new Date(daysAgo(PROPOSED.observationFreshDays).getTime() - 1),
      "stale",
    ],
    [
      "exactly expiry limit",
      daysAgo(PROPOSED.observationExpiredAfterDays),
      "stale",
    ],
    [
      "past expiry",
      daysAgo(PROPOSED.observationExpiredAfterDays + 1),
      "expired",
    ],
  ])("%s", (_l, at, expected) => {
    expect(observationFreshness(at, AS_OF)).toBe(expected);
  });
});

describe("Stage 3D-1m — social evidence per platform", () => {
  const measure = (over: Partial<EvidenceQualityInput>) => {
    const i = input(over);
    return measureSocialEvidence(
      i.creators,
      i.verifications,
      i.observations,
      i.connections,
      AS_OF,
    );
  };

  it("counts accounts, observation coverage, freshness and failures per platform", () => {
    const r = measure({
      creators: [
        { profileType: "Influencer", profile: creator("c1") },
        { profileType: "Influencer", profile: creator("c2") },
        { profileType: "Influencer", profile: creator("c3") },
      ],
      observations: [
        ytObservation("c1"),
        ytObservation("c2", {
          capturedAt: daysAgo(200),
          lastAttemptAt: daysAgo(200),
        }),
        // A failed latest attempt keeps the earlier success (by design).
        ytObservation("c3", {
          status: "failed",
          lastError: "rate_limited",
          lastAttemptAt: daysAgo(1),
          capturedAt: daysAgo(40),
        }),
      ],
    });
    const yt = r.byPlatform.youtube;
    expect(yt.accounts).toBe(3);
    expect(yt.attempted).toBe(3);
    expect(yt.freshness).toEqual({ fresh: 1, stale: 1, expired: 1, never: 0 });
    // Expired evidence is not usable; fresh + stale are.
    expect(yt.usableObservedFollowers).toBe(2);
    expect(yt.lastAttemptFailed).toBe(1);
    expect(yt.failureReasons).toEqual({ rate_limited: 1 });
    expect(r.byPlatform.instagram.freshness.never).toBe(3);
    expect(r.overall.accounts).toBe(6);
    expect(r.overall.usableObservedFollowersPct).toBe(33.3);
  });

  it("hidden follower counts are observed but not usable follower evidence", () => {
    const r = measure({
      observations: [ytObservation("c1", { observedFollowersCount: null })],
    });
    expect(r.byPlatform.youtube.freshness.fresh).toBe(1);
    expect(r.byPlatform.youtube.usableObservedFollowers).toBe(0);
  });

  it("uses the shared Meta connection rule (Instagram needs the business account)", () => {
    expect([...connectedPlatformsFrom([{ platform: "instagram" }])]).toEqual(
      [],
    );
    expect([
      ...connectedPlatformsFrom([
        { platform: "instagram", instagramBusinessAccountId: "1784" },
        { platform: "facebook" },
      ]),
    ]).toEqual(["instagram", "facebook"]);
    const withConn = measure({
      connections: [
        {
          userId: "c1",
          userType: "Influencer",
          platform: "instagram",
          instagramBusinessAccountId: "1784",
        },
      ],
    });
    expect(withConn.byPlatform.instagram).toMatchObject({
      requiresConnection: 1,
      connected: 1,
    });
    const noBiz = measure({
      connections: [
        { userId: "c1", userType: "Influencer", platform: "instagram" },
      ],
    });
    expect(noBiz.byPlatform.instagram.connected).toBe(0);
    expect(noBiz.byPlatform.youtube.requiresConnection).toBe(0);
  });

  it("declared vs observed tier and handle come from the existing comparison", () => {
    // Declared Micro; 5000 observed → Micro (match). 27 observed → Starter (mismatch).
    const match = measure({ observations: [ytObservation("c1")] });
    expect(match.byPlatform.youtube.declaredVsObservedTier).toEqual({
      match: 1,
      mismatch: 0,
      not_available: 0,
    });
    expect(match.byPlatform.youtube.handleConsistency.match).toBe(1);
    const mismatch = measure({
      observations: [
        ytObservation("c1", {
          observedFollowersCount: 27,
          observedHandle: "other",
        }),
      ],
    });
    expect(mismatch.byPlatform.youtube.declaredVsObservedTier.mismatch).toBe(1);
    expect(mismatch.byPlatform.youtube.handleConsistency.mismatch).toBe(1);
    expect(
      mismatch.byPlatform.instagram.declaredVsObservedTier.not_available,
    ).toBe(1);
  });

  it("verification states use effectiveDecision (stale decisions are not verified)", () => {
    const r = measure({
      creators: [
        { profileType: "Influencer", profile: creator("c1") },
        { profileType: "Influencer", profile: creator("c2") },
      ],
      verifications: [
        {
          profileType: "Influencer",
          profileId: "c1",
          socialAccountId: YT_ID,
          ownership: {
            status: "verified",
            method: "manual",
            decidedHandle: "@chan",
          },
          tier: { status: "verified", method: "manual", decidedTier: "Micro" },
        },
        {
          profileType: "Influencer",
          profileId: "c2",
          socialAccountId: YT_ID,
          // Reviewed when the tier was Nano; the creator now declares Micro → stale.
          tier: { status: "verified", method: "manual", decidedTier: "Nano" },
          ownership: { status: "pending", invalidatedAt: daysAgo(3) },
        },
        {
          profileType: "Influencer",
          profileId: "c2",
          socialAccountId: IG_ID,
          tier: { status: "rejected", method: "manual", decidedTier: "Micro" },
        },
      ],
    });
    expect(r.byPlatform.youtube.tier).toEqual({
      verified: 1,
      rejected: 0,
      never_reviewed: 0,
      changed_since_review: 1,
    });
    expect(r.byPlatform.youtube.ownership).toEqual({
      verified: 1,
      rejected: 0,
      never_reviewed: 0,
      changed_since_review: 1,
    });
    expect(r.byPlatform.instagram.tier).toMatchObject({
      rejected: 1,
      never_reviewed: 1,
    });
  });

  it("labels small samples as insufficient", () => {
    const r = measure({});
    expect(r.byPlatform.youtube.sample).toBe("insufficient");
    const many = measure({
      creators: Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) => ({
        profileType: "Influencer" as const,
        profile: creator(`c${i}`),
      })),
    });
    expect(many.byPlatform.youtube.sample).toBe("sufficient");
  });
});

describe("Stage 3D-1m — creator data shape", () => {
  const norm = (over: Record<string, any>) =>
    normalizeCreatorMatchInput(creator("x", over), "Influencer");

  it("activity buckets reuse the Stage 3C-1 rule; unknown is counted, not dropped", () => {
    const r = measureCreatorData(
      [
        norm({ lastLoginAt: daysAgo(1) }),
        norm({ lastLoginAt: daysAgo(20) }),
        norm({ lastLoginAt: daysAgo(60) }),
        norm({ lastLoginAt: daysAgo(120) }),
        norm({ lastLoginAt: null }),
      ],
      AS_OF,
    );
    expect(r.activity).toEqual({
      within_7_days: 1,
      within_8_30_days: 1,
      within_31_90_days: 1,
      over_90_days: 1,
      unknown: 1,
    });
    expect(r.activityUnknownPct).toBe(20);
  });

  it("rates: below the proposed minimum, round-number share, confirmation not tracked yet", () => {
    const r = measureCreatorData(
      [
        norm({}),
        norm({
          socialMedia: [
            {
              socialAccountId: YT_ID,
              platform: "Instagram",
              handle: "a",
              tier: "Micro",
              contentTypes: [
                { name: "Reel", enabled: true, price: 0.5 },
                { name: "Story (24h)", enabled: true, price: 1000 },
                { name: "Photo post", enabled: false, price: 1 },
              ],
            },
          ],
        }),
      ],
      AS_OF,
    );
    // Rows: 500, 1200, 0.5, 1000 (disabled row ignored).
    expect(r.rates).toEqual({
      enabledRows: 4,
      pricedRows: 4,
      belowProposedMinimum: 1,
      multipleOf500: 2,
      multipleOf500Pct: 50,
      confirmationTracked: true,
      confirmedRows: 0,
      confirmedPct: 0,
    });
  });

  it("legacy 'off' is never read as 'not available'; only an explicit state is (3D-1d)", () => {
    const r = measureCreatorData(
      [
        norm({}),
        norm({ collaborationAvailability: { enabled: false } }),
        norm({ collaborationAvailability: undefined }),
        norm({
          collaborationAvailability: {
            enabled: false,
            state: "not_available",
            // A running period (an ended one reads as not set).
            notAvailableUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          },
        }),
        norm({
          collaborationAvailability: { enabled: true, state: "available" },
        }),
      ],
      AS_OF,
    );
    expect(r.availability).toEqual({
      available: 2,
      notAvailable: 1,
      notSet: 2,
      explicitStateTracked: true,
    });
  });

  it("counts rates with a confirmation date (3D-1d)", () => {
    const r = measureCreatorData(
      [
        norm({
          socialMedia: [
            {
              socialAccountId: "64b0000000000000000000a9",
              platformKey: "instagram",
              platform: "Instagram",
              handle: "a",
              tier: "Micro",
              contentTypes: [
                {
                  name: "Reel",
                  enabled: true,
                  price: 1000,
                  priceConfirmedAt: AS_OF,
                },
                {
                  name: "Story (24h)",
                  enabled: true,
                  price: 1000,
                  priceConfirmedAt: null,
                },
              ],
            },
          ],
        }),
      ],
      AS_OF,
    );
    expect(r.rates).toMatchObject({
      pricedRows: 2,
      confirmedRows: 1,
      confirmedPct: 50,
    });
  });

  it("category breadth and the over-cap legacy count", () => {
    const r = measureCreatorData(
      [
        norm({ categories: ["A"] }),
        norm({ categories: ["A", "B", "C", "D", "E"] }),
        norm({ categories: Array.from({ length: 19 }, (_, i) => `C${i}`) }),
      ],
      AS_OF,
    );
    expect(r.categories).toEqual({
      perCreator: { "1": 1, "5": 1, "6+": 1 },
      overCurrentCap: 1,
      cap: 5,
    });
  });
});

describe("Stage 3D-1m — outcome coverage", () => {
  it("separates live from backfilled events and counts approved creators only", () => {
    const r = measureOutcomes(
      [
        { eventType: "invite_accepted", influencerId: "a" },
        {
          eventType: "invite_accepted",
          influencerId: "b",
          metadata: { source: "backfill" },
        },
        { eventType: "campaign_created" },
        { eventType: "content_approved", influencerId: "zz" },
        // Production ids are ObjectIds.
        {
          eventType: "content_approved",
          influencerId: new Types.ObjectId("64b0000000000000000000ff"),
        },
      ],
      new Set(["a", "b", "64b0000000000000000000ff"]),
    );
    expect(r).toMatchObject({
      total: 5,
      live: 4,
      backfilled: 1,
      approvedCreatorsWithAnyEvent: 3,
      sample: "insufficient",
    });
    expect(r.byType.invite_accepted).toEqual({
      total: 2,
      live: 1,
      backfilled: 1,
    });
    expect(Object.keys(r.liveCaptureSince)).toEqual(["stage1", "stage15"]);
  });
});

describe("Stage 3D-1m — ranking resolution", () => {
  const ranked = (
    id: string,
    pc: [number, number],
    cat: [number, number],
    bucket: RankedCreator["activity"]["bucket"],
  ): RankedCreator =>
    ({
      creatorId: id,
      rank: 0,
      platformContent: { matched: Array(pc[0]).fill("x"), total: pc[1] },
      category: { matched: Array(cat[0]).fill("y"), total: cat[1] },
      activity: { bucket, lastActiveAt: null, daysSinceActive: null },
      rankingReasons: [],
    }) as RankedCreator;

  it("attributes each pair to the first layer that separates it", () => {
    // Already in Stage 3C-1 order.
    const list = [
      ranked("a", [2, 2], [1, 2], "within_7_days"),
      ranked("b", [1, 2], [2, 2], "within_7_days"),
      ranked("c", [1, 2], [1, 2], "within_7_days"),
      ranked("d", [1, 2], [1, 2], "within_31_90_days"),
      ranked("e", [1, 2], [1, 2], "unknown"), // shares the 31–90d key
    ];
    const r = rankingResolution(list);
    // 10 pairs: a vs others (4) by platform; b vs c,d,e (3) by category;
    // c vs d,e (2) by activity; d–e (1) only by creator id.
    expect(r.decidedPairs).toEqual({
      platformContent: 4,
      category: 3,
      activity: 2,
      creatorId: 1,
    });
    expect(r.totalPairs).toBe(10);
    expect(r.distinctSignalCombinations).toBe(4);
    expect(r.creatorsInTieGroups).toBe(2);
    expect(r.largestTieGroup).toBe(2);
    expect(r.topNCutoffInTie).toEqual({ top5: null, top10: null, top25: null });
    expect(ACTIVITY_BUCKET_ORDER.unknown).toBe(
      ACTIVITY_BUCKET_ORDER.within_31_90_days,
    );
  });

  it("detects a top-N cutoff that falls inside a tie group", () => {
    const list = Array.from({ length: 7 }, (_, i) =>
      ranked(`c${i}`, [1, 1], [i < 3 ? 2 : 1, 2], "within_31_90_days"),
    );
    // Positions 4..7 share keys → the 5th/6th boundary is inside that group.
    expect(rankingResolution(list).topNCutoffInTie.top5).toBe(true);
    expect(rankingResolution(list).topNCutoffInTie.top10).toBeNull();
    // Make the 5th and 6th creators differ → the top-5 cutoff is evidence-based.
    const split = [
      ...list.slice(0, 5),
      ranked("z5", [1, 1], [1, 2], "over_90_days"),
      ranked("z6", [1, 1], [1, 2], "over_90_days"),
    ];
    expect(rankingResolution(split).topNCutoffInTie.top5).toBe(false);
  });

  it("uses the real eligibility + ranking: only PASS creators are measured", () => {
    const campaign = {
      _id: "camp-1",
      status: "active",
      ownerType: "brand",
      inviteRecipientRole: "influencer",
      platforms: ["Instagram"],
      categories: ["Fashion", "Food"],
      socialMedia: [
        {
          platform: "Instagram",
          contentTypes: [{ name: "Reel", enabled: true, price: 1000 }],
        },
      ],
      languages: ["Telugu"],
    };
    const creators = [
      creator("p1", { categories: ["Fashion", "Food"] }),
      creator("p2"),
      creator("f1", { languages: ["Hindi"] }),
      creator("u1", { languages: [] }),
    ].map((p) => ({
      profileType: "Influencer",
      input: normalizeCreatorMatchInput(p, "Influencer"),
    }));
    const r = measureRankingResolution([campaign], creators, AS_OF);
    expect(r.campaigns[0]).toMatchObject({
      eligible: 2,
      ranked: 2,
      totalPairs: 1,
    });
    expect(r.campaigns[0].decidedPairs.category).toBe(1);
    expect(r.overall.decidedPairsPct.category).toBe(100);
  });
});

describe("Stage 3D-1m — report", () => {
  it("measures approved, non-deleted creators only and is deterministic for one asOf", () => {
    const i = input({
      creators: [
        { profileType: "Influencer", profile: creator("ok") },
        {
          profileType: "Influencer",
          profile: creator("pending", { verificationStatus: "pending" }),
        },
        {
          profileType: "Influencer",
          profile: creator("gone", { isDeleted: true }),
        },
        {
          profileType: "Photographer",
          profile: creator("ph", { skills: ["Wedding"], socialMedia: [] }),
        },
      ],
      observations: [ytObservation("ok")],
    });
    const before = JSON.stringify(i);
    const a = buildEvidenceQualityReport(i);
    expect(JSON.stringify(i)).toBe(before); // input not mutated
    expect(JSON.stringify(buildEvidenceQualityReport(i))).toBe(
      JSON.stringify(a),
    );
    expect(a.asOf).toBe(AS_OF.toISOString());
    expect(a.population).toEqual({
      influencers: { evaluated: 2, approvedActive: 1 },
      photographers: { evaluated: 1, approvedActive: 1 },
    });
    expect(a.socialEvidence.overall.accounts).toBe(2); // only "ok"'s two accounts
    expect(a.definitions.proposedThresholds).toEqual(PROPOSED);
  });

  it("rejects an invalid asOf", () => {
    expect(() =>
      buildEvidenceQualityReport(input({ asOf: new Date("x") })),
    ).toThrow(/asOf/);
  });

  it("contains no ranking score or weight", () => {
    const text = JSON.stringify(buildEvidenceQualityReport(input()));
    expect(text).not.toMatch(/"score"|weight/i);
  });
});

describe("Stage 3D-1m — service is read-only", () => {
  it("only calls find(); never loads tokens, contact details, passwords or payout data", async () => {
    const calls: Array<{ name: string; filter: any; options: any }> = [];
    const collection = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop !== "find")
              throw new Error(`unexpected ${String(prop)} on ${name}`);
            return (filter: any, options: any) => {
              calls.push({ name, filter, options });
              return {
                toArray: () =>
                  Promise.resolve(
                    name === "influencers" ? [creator("c1")] : [],
                  ),
              };
            };
          },
        },
      );
    const report = await new EvidenceQualityService({
      collection,
    } as any).getReport(AS_OF);
    expect(calls.map((c) => c.name).sort()).toEqual([
      "campaigns",
      "influencers",
      "photographers",
      "platform_events",
      "social_account_observations",
      "social_account_verifications",
      "social_oauth_connections",
    ]);
    const conn = calls.find((c) => c.name === "social_oauth_connections")!;
    expect(conn.options.projection.accessToken).toBeUndefined();
    expect(Object.keys(conn.options.projection)).not.toContain("accessToken");
    for (const name of ["influencers", "photographers"]) {
      const keys = Object.keys(
        calls.find((c) => c.name === name)!.options.projection,
      );
      for (const secret of [
        "email",
        "phoneNumber",
        "password",
        "payout",
        "resetToken",
      ])
        expect(keys).not.toContain(secret);
      expect(calls.find((c) => c.name === name)!.filter).toEqual({
        isDeleted: { $ne: true },
      });
    }
    expect(report.population.influencers.approvedActive).toBe(1);
  });
});
