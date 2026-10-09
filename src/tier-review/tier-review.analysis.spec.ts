import {
  TierReviewInput,
  buildTierReviewItems,
  tierReviewQueue,
} from "./tier-review.analysis";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date("2026-10-08T12:00:00.000Z");
const daysAgo = (d: number) => new Date(AS_OF.getTime() - d * DAY);

const YT = "64b0000000000000000000a1";
const IG = "64b0000000000000000000a2";

const creator = (id: string, over: Record<string, any> = {}) => ({
  _id: id,
  name: `Creator ${id}`,
  username: `user-${id}`,
  createdAt: daysAgo(100),
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  socialMedia: [
    {
      socialAccountId: YT,
      platformKey: "youtube",
      platform: "YouTube",
      handle: "@chan",
      tier: "Micro",
    },
    {
      socialAccountId: IG,
      platformKey: "instagram",
      platform: "Instagram",
      handle: "insta",
      tier: "Micro",
    },
  ],
  ...over,
});

const ytObs = (profileId: string, followers: number, capturedDaysAgo = 2) => ({
  profileType: "Influencer",
  profileId,
  socialAccountId: YT,
  platformKey: "youtube",
  source: "youtube",
  externalAccountId: "UCabcdefghijklmnopqrstuv",
  observedHandle: "chan",
  observedFollowersCount: followers,
  capturedAt: daysAgo(capturedDaysAgo),
  status: "success",
  lastAttemptAt: daysAgo(capturedDaysAgo),
});

const tierDecision = (
  profileId: string,
  socialAccountId: string,
  decidedTier: string,
  decidedDaysAgo: number,
  status = "verified",
) => ({
  profileType: "Influencer",
  profileId,
  socialAccountId,
  tier: {
    status,
    method: "manual",
    decidedTier,
    decidedAt: daysAgo(decidedDaysAgo),
    decidedByName: "Admin",
  },
});

const input = (over: Partial<TierReviewInput> = {}): TierReviewInput => ({
  asOf: AS_OF,
  creators: [],
  verifications: [],
  observations: [],
  connections: [],
  ...over,
});

const reasonsOf = (i: TierReviewInput) =>
  buildTierReviewItems(i).map(
    (x) => `${x.profileId}:${x.platformKey}:${x.reason}`,
  );

describe("tier review queue (Stage 3D-1b)", () => {
  it("never-reviewed accounts are queued; verified ones that still match are not", () => {
    const i = input({
      creators: [{ profileType: "Influencer", profile: creator("a") }],
      verifications: [tierDecision("a", IG, "Micro", 5)],
    });
    expect(reasonsOf(i)).toEqual(["a:youtube:never_reviewed"]);
  });

  it("a tier changed after the review comes first, as changed_since_review", () => {
    const i = input({
      creators: [
        { profileType: "Influencer", profile: creator("a") },
        // b's Instagram was verified as Nano, but b now declares Micro.
        { profileType: "Influencer", profile: creator("b") },
      ],
      verifications: [tierDecision("b", IG, "Nano", 10)],
    });
    const items = buildTierReviewItems(i);
    expect(items[0]).toMatchObject({
      profileId: "b",
      platformKey: "instagram",
      reason: "changed_since_review",
      decision: { status: "pending", decidedTier: "Nano" },
    });
  });

  it("a usable observation in another tier is observed_mismatch, with the evidence inline", () => {
    const i = input({
      creators: [{ profileType: "Influencer", profile: creator("a") }],
      observations: [ytObs("a", 50_000)], // Mid-Tier, declared Micro
    });
    const yt = buildTierReviewItems(i).find(
      (x) => x.platformKey === "youtube",
    )!;
    expect(yt).toMatchObject({
      reason: "observed_mismatch",
      declaredVsObserved: "mismatch",
      observedUsable: true,
      observed: {
        followers: 50_000,
        tier: { key: "mid_tier" },
        freshness: "fresh",
      },
    });
  });

  it("a matching observation leaves a never-reviewed account as never_reviewed (decidable on observed evidence)", () => {
    const i = input({
      creators: [{ profileType: "Influencer", profile: creator("a") }],
      observations: [ytObs("a", 5_000)], // Micro, as declared
    });
    const yt = buildTierReviewItems(i).find(
      (x) => x.platformKey === "youtube",
    )!;
    expect(yt).toMatchObject({
      reason: "never_reviewed",
      declaredVsObserved: "match",
      observedUsable: true,
    });
  });

  it("a decision taken after the mismatching observation is respected; a newer observation re-queues it", () => {
    const decidedAfter = input({
      creators: [{ profileType: "Influencer", profile: creator("a") }],
      observations: [ytObs("a", 50_000, 5)],
      verifications: [
        tierDecision("a", YT, "Micro", 1),
        tierDecision("a", IG, "Micro", 1),
      ],
    });
    expect(reasonsOf(decidedAfter)).toEqual([]);

    const observedAfter = input({
      ...decidedAfter,
      observations: [ytObs("a", 50_000, 1)],
      verifications: [
        tierDecision("a", YT, "Micro", 5),
        tierDecision("a", IG, "Micro", 5),
      ],
    });
    expect(reasonsOf(observedAfter)).toEqual(["a:youtube:observed_mismatch"]);
  });

  it("expired observations are not evidence of a mismatch", () => {
    const i = input({
      creators: [{ profileType: "Influencer", profile: creator("a") }],
      observations: [ytObs("a", 50_000, 120)],
    });
    const yt = buildTierReviewItems(i).find(
      (x) => x.platformKey === "youtube",
    )!;
    expect(yt).toMatchObject({
      reason: "never_reviewed",
      observedUsable: false,
    });
    expect(yt.observed.freshness).toBe("expired");
  });

  it("only approved, active creators; accounts without a declared tier are skipped", () => {
    const i = input({
      creators: [
        {
          profileType: "Influencer",
          profile: creator("pending", { verificationStatus: "pending" }),
        },
        {
          profileType: "Influencer",
          profile: creator("deleted", { isDeleted: true }),
        },
        {
          profileType: "Influencer",
          profile: creator("notier", {
            socialMedia: [
              {
                socialAccountId: YT,
                platformKey: "youtube",
                platform: "YouTube",
                handle: "x",
                tier: "",
              },
            ],
          }),
        },
      ],
    });
    expect(buildTierReviewItems(i)).toEqual([]);
  });

  it("orders by reason, then oldest first; filters, counts and pages", () => {
    const i = input({
      creators: [
        {
          profileType: "Influencer",
          profile: creator("new", { createdAt: daysAgo(5) }),
        },
        {
          profileType: "Influencer",
          profile: creator("old", { createdAt: daysAgo(50) }),
        },
      ],
      observations: [ytObs("new", 50_000)],
    });
    expect(reasonsOf(i)).toEqual([
      "new:youtube:observed_mismatch",
      "old:youtube:never_reviewed",
      "old:instagram:never_reviewed",
      "new:instagram:never_reviewed",
    ]);

    const page = tierReviewQueue(i, {
      reason: "never_reviewed",
      pageSize: 2,
      page: 2,
    });
    expect(page.counts).toEqual({
      changed_since_review: 0,
      observed_mismatch: 1,
      never_reviewed: 3,
    });
    expect(page.total).toBe(4);
    expect(page.filtered).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(page.items.map((x) => x.profileId)).toEqual(["new"]);
    expect(page.platforms).toEqual({ youtube: 2, instagram: 2 });

    expect(tierReviewQueue(i, { platform: "youtube" }).total).toBe(2);
    expect(tierReviewQueue(i, { q: "user-old" }).total).toBe(2);
    expect(tierReviewQueue(i, { q: "@chan" }).total).toBe(2);
  });

  it("carries links to the account: the observed channel page and the creator's saved profile link", () => {
    const c = creator("c1");
    c.socialMedia[0] = {
      ...c.socialMedia[0],
      url: "youtube.com/@chan",
    } as any;
    const items = buildTierReviewItems(
      input({
        creators: [{ profileType: "Influencer", profile: c }],
        observations: [
          {
            ...ytObs("c1", 5000),
            externalUrl:
              "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
          },
        ],
      }),
    );
    const yt = items.find((i) => i.platformKey === "youtube")!;
    expect(yt.observed.externalUrl).toBe(
      "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    );
    expect(yt.profileUrl).toBe("https://youtube.com/@chan"); // bare link made https
    const ig = items.find((i) => i.platformKey === "instagram")!;
    expect(ig.profileUrl).toBeNull(); // nothing saved → the page builds it from the handle
    expect(ig.observed.externalUrl).toBeNull();
  });

  it("never passes a non-web link through", () => {
    const c = creator("c1");
    c.socialMedia[0] = {
      ...c.socialMedia[0],
      url: "javascript:alert(1)",
    } as any;
    const [yt] = buildTierReviewItems(
      input({ creators: [{ profileType: "Influencer", profile: c }] }),
    ).filter((i) => i.platformKey === "youtube");
    expect(yt.profileUrl).toBeNull();
  });
});
