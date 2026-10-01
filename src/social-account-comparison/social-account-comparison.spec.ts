import {
  buildSocialAccountComparison,
  observedTierFor,
} from "./social-account-comparison";
import { SocialAccountComparisonService } from "./social-account-comparison.service";

const ID = "64b0000000000000000000a1";
const CHANNEL = "UCabcdefghijklmnopqrstuv";

const ytEntry = (over: Record<string, any> = {}) => ({
  socialAccountId: ID,
  platformKey: "youtube",
  platform: "YouTube",
  handle: "rebuildwithsundeep",
  tier: "Micro",
  followersCount: 0,
  contentTypes: [{ name: "Video", price: 1000 }],
  ...over,
});

const observationView = (
  latest: Record<string, any> | null,
  attempt: Record<string, any> = {},
) => ({
  socialAccountId: ID,
  platform: "YouTube",
  platformKey: "youtube",
  observable: true,
  requiresConnection: false,
  connected: null,
  observation: {
    status: "success" as const,
    lastError: null,
    lastAttemptAt: new Date("2026-10-01T06:27:34.000Z"),
    latest: latest
      ? {
          source: "youtube" as const,
          externalAccountId: CHANNEL,
          observedHandle: "rebuildwithsundeep",
          observedFollowersCount: 27,
          externalUrl: `https://www.youtube.com/channel/${CHANNEL}`,
          rawPlatformUpdatedAt: null,
          capturedAt: new Date("2026-10-01T06:27:34.000Z"),
          ...latest,
        }
      : null,
    ...attempt,
  },
});

const decided = (over: Record<string, any>) => ({
  method: "manual",
  decidedAt: new Date("2026-10-01T05:06:00.000Z"),
  decidedById: "admin-1",
  decidedByName: "Admin User",
  decidedByRole: "admin",
  note: "",
  ...over,
});

describe("buildSocialAccountComparison (Stage 3A-3)", () => {
  describe("DECLARED", () => {
    it("returns the declared handle, tier and self-reported stats as stored", () => {
      const c = buildSocialAccountComparison(
        ytEntry({
          selfReportedStats: {
            avgLikes: 12,
            avgComments: 3,
            postFrequencyPerWeek: 2,
            lastUpdatedAt: "2026-09-01T00:00:00.000Z",
          },
        }),
        null,
        null,
      );
      expect(c.socialAccountId).toBe(ID);
      expect(c.declared).toEqual({
        handle: "rebuildwithsundeep",
        tier: "Micro",
        followersCount: null,
        selfReportedStats: {
          avgLikes: 12,
          avgComments: 3,
          postFrequencyPerWeek: 2,
          lastUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
    });

    it("returns a declared follower count when there is one; 0/missing means not declared", () => {
      expect(
        buildSocialAccountComparison(
          ytEntry({ followersCount: 5000 }),
          null,
          null,
        ).declared.followersCount,
      ).toBe(5000);
      expect(
        buildSocialAccountComparison(ytEntry({ followersCount: 0 }), null, null)
          .declared.followersCount,
      ).toBeNull();
      expect(
        buildSocialAccountComparison(
          ytEntry({ followersCount: undefined }),
          null,
          null,
        ).declared.followersCount,
      ).toBeNull();
      expect(
        buildSocialAccountComparison(ytEntry(), null, null).declared
          .selfReportedStats,
      ).toBeNull();
    });
  });

  describe("VERIFIED", () => {
    it.each([
      [
        "verified",
        decided({ status: "verified", decidedHandle: "rebuildwithsundeep" }),
      ],
      [
        "rejected",
        decided({
          status: "rejected",
          decidedHandle: "rebuildwithsundeep",
          note: "Not theirs",
        }),
      ],
    ])("ownership %s is returned with who/when/what", (status, decision) => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        { ownershipVerification: decision as any },
        null,
      );
      expect(c.verified.ownership).toEqual({
        status,
        method: "manual",
        reviewedHandle: "rebuildwithsundeep",
        reviewedAt: new Date("2026-10-01T05:06:00.000Z"),
        reviewedBy: "Admin User",
        note: decision.note,
        changedSinceReview: false,
      });
    });

    it.each([
      ["verified", "Micro"],
      ["rejected", "Micro"],
    ])("tier %s is returned with the reviewed tier", (status, tier) => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        { tierVerification: decided({ status, decidedTier: tier }) as any },
        null,
      );
      expect(c.verified.tier).toMatchObject({
        status,
        reviewedTier: tier,
        reviewedBy: "Admin User",
      });
    });

    it("pending (no decision) for both reviews", () => {
      const c = buildSocialAccountComparison(ytEntry(), null, null);
      expect(c.verified.ownership).toEqual({
        status: "pending",
        method: null,
        reviewedHandle: null,
        reviewedAt: null,
        reviewedBy: null,
        note: null,
        changedSinceReview: false,
      });
      expect(c.verified.tier).toMatchObject({
        status: "pending",
        reviewedTier: null,
      });
    });

    it("pending after a change is marked changedSinceReview", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        {
          ownershipVerification: { status: "pending", stale: true } as any,
          tierVerification: {
            status: "pending",
            invalidatedAt: new Date(),
          } as any,
        },
        null,
      );
      expect(c.verified.ownership.changedSinceReview).toBe(true);
      expect(c.verified.tier.changedSinceReview).toBe(true);
    });
  });

  describe("OBSERVED", () => {
    it("returns the latest successful observation and the latest attempt", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        null,
        observationView({}) as any,
      );
      expect(c.observed).toEqual({
        available: true,
        requiresConnection: false,
        connected: null,
        lastAttempt: {
          status: "success",
          at: new Date("2026-10-01T06:27:34.000Z"),
          error: null,
        },
        latest: {
          externalAccountId: CHANNEL,
          observedHandle: "rebuildwithsundeep",
          observedFollowersCount: 27,
          source: "youtube",
          capturedAt: new Date("2026-10-01T06:27:34.000Z"),
          externalUrl: `https://www.youtube.com/channel/${CHANNEL}`,
        },
      });
    });

    it("a failed latest attempt keeps the previous successful observation", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        null,
        observationView(
          {},
          { status: "failed", lastError: "rate_limited" },
        ) as any,
      );
      expect(c.observed.lastAttempt).toMatchObject({
        status: "failed",
        error: "rate_limited",
      });
      expect(c.observed.latest?.observedFollowersCount).toBe(27);
      expect(c.comparison.tier.observed).toEqual({
        key: "starter",
        label: "Starter",
      });
    });

    it("no observation → not available everywhere", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ followersCount: 5000 }),
        null,
        null,
      );
      expect(c.observed).toEqual({
        available: false,
        requiresConnection: false,
        connected: null,
        lastAttempt: null,
        latest: null,
      });
      expect(c.comparison.handle).toEqual({
        declared: "rebuildwithsundeep",
        observed: null,
        status: "not_available",
      });
      expect(c.comparison.tier).toMatchObject({
        observed: null,
        declaredVsObserved: "not_available",
        verifiedVsObserved: "not_available",
      });
      expect(c.comparison.followers).toEqual({
        declared: 5000,
        observed: null,
        comparisonAvailable: false,
        difference: null,
      });
    });

    it("only a failed attempt (never succeeded) → not available, with the reason", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        null,
        observationView(null, {
          status: "failed",
          lastError: "authorization_required",
        }) as any,
      );
      expect(c.observed.available).toBe(false);
      expect(c.observed.lastAttempt?.error).toBe("authorization_required");
    });

    it("hidden follower count → no observed tier and no follower comparison (never treated as 0)", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ followersCount: 5000 }),
        null,
        observationView({ observedFollowersCount: null }) as any,
      );
      expect(c.comparison.tier.observed).toBeNull();
      expect(c.comparison.tier.declaredVsObserved).toBe("not_available");
      expect(c.comparison.followers).toEqual({
        declared: 5000,
        observed: null,
        comparisonAvailable: false,
        difference: null,
      });
    });
  });

  describe("COMPARISON — handle", () => {
    it.each([
      ["@RebuildWithSundeep", "rebuildwithsundeep"],
      ["  rebuildwithsundeep ", "RebuildWithSundeep"],
      ["https://www.youtube.com/@rebuildwithsundeep", "rebuildwithsundeep"],
      [`https://www.youtube.com/channel/${CHANNEL}`, "rebuildwithsundeep"], // id vs observed channel id
    ])(
      "YouTube %p vs observed %p → match",
      (declaredHandle, observedHandle) => {
        const c = buildSocialAccountComparison(
          ytEntry({ handle: declaredHandle }),
          null,
          observationView({ observedHandle }) as any,
        );
        expect(c.comparison.handle.status).toBe("match");
      },
    );

    it.each([
      ["rebuildwithsundeep1", "rebuildwithsundeep"],
      ["someone.else", "rebuildwithsundeep"],
      ["UCzzzzzzzzzzzzzzzzzzzzzz", "rebuildwithsundeep"],
    ])(
      "YouTube %p vs observed %p → mismatch (no fuzzy matching)",
      (declaredHandle, observedHandle) => {
        const c = buildSocialAccountComparison(
          ytEntry({ handle: declaredHandle }),
          null,
          observationView({ observedHandle }) as any,
        );
        expect(c.comparison.handle.status).toBe("mismatch");
      },
    );

    it("Instagram URL vs observed username, and Facebook page id vs observed id", () => {
      const ig = buildSocialAccountComparison(
        {
          socialAccountId: ID,
          platformKey: "instagram",
          platform: "Instagram",
          handle: "https://instagram.com/Creator.123/",
          tier: "Nano",
        },
        null,
        observationView({
          observedHandle: "creator.123",
          externalAccountId: "178",
          source: "instagram",
        }) as any,
      );
      expect(ig.comparison.handle.status).toBe("match");
      const fb = buildSocialAccountComparison(
        {
          socialAccountId: ID,
          platformKey: "facebook",
          platform: "Facebook",
          handle: "https://facebook.com/profile.php?id=1234567890",
          tier: "Nano",
        },
        null,
        observationView({
          observedHandle: "mypage.official",
          externalAccountId: "1234567890",
          source: "facebook",
        }) as any,
      );
      expect(fb.comparison.handle.status).toBe("match");
    });

    it("an empty declared handle is not compared", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ handle: "" }),
        null,
        observationView({}) as any,
      );
      expect(c.comparison.handle.status).toBe("not_available");
    });
  });

  describe("COMPARISON — tier", () => {
    it.each([
      [0, "below_starter"],
      [1, "starter"],
      [100, "starter"],
      [101, "nano"],
      [1000, "nano"],
      [1001, "micro"],
      [10000, "micro"],
      [10001, "mid_tier"],
      [100000, "mid_tier"],
      [100001, "macro"],
      [1000000, "macro"],
      [1000001, "mega"],
    ])("observed %d followers → %s", (n, key) => {
      expect(observedTierFor(n)?.key).toBe(key);
    });

    it("null observed followers → no observed tier", () => {
      expect(observedTierFor(null)).toBeNull();
    });

    it("declared Micro vs observed 27 (Starter) → mismatch; verified tier only counts when verified", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        {
          tierVerification: decided({
            status: "verified",
            decidedTier: "Micro",
          }) as any,
        },
        observationView({ observedFollowersCount: 27 }) as any,
      );
      expect(c.comparison.tier).toEqual({
        declared: { key: "micro", label: "Micro" },
        verified: { key: "micro", label: "Micro" },
        observed: { key: "starter", label: "Starter" },
        declaredVsObserved: "mismatch",
        verifiedVsObserved: "mismatch",
      });
      // The verified decision itself is reported unchanged.
      expect(c.verified.tier).toMatchObject({
        status: "verified",
        reviewedTier: "Micro",
      });
    });

    it('matching tiers, spelling-tolerant ("Mid tier" = Mid-Tier)', () => {
      const c = buildSocialAccountComparison(
        ytEntry({ tier: "Mid tier" }),
        {
          tierVerification: decided({
            status: "verified",
            decidedTier: "Mid-Tier",
          }) as any,
        },
        observationView({ observedFollowersCount: 12500 }) as any,
      );
      expect(c.comparison.tier).toMatchObject({
        declaredVsObserved: "match",
        verifiedVsObserved: "match",
      });
    });

    it("a rejected or pending tier has no verified tier to compare", () => {
      for (const decision of [
        decided({ status: "rejected", decidedTier: "Micro" }),
        { status: "pending" },
      ]) {
        const c = buildSocialAccountComparison(
          ytEntry(),
          { tierVerification: decision as any },
          observationView({}) as any,
        );
        expect(c.comparison.tier.verified).toBeNull();
        expect(c.comparison.tier.verifiedVsObserved).toBe("not_available");
      }
    });

    it("an unrecognised declared tier is not compared", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ tier: "Gold" }),
        null,
        observationView({}) as any,
      );
      expect(c.comparison.tier.declared).toBeNull();
      expect(c.comparison.tier.declaredVsObserved).toBe("not_available");
    });
  });

  describe("COMPARISON — followers", () => {
    it("difference = observed − declared when both known", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ followersCount: 5000 }),
        null,
        observationView({ observedFollowersCount: 7800 }) as any,
      );
      expect(c.comparison.followers).toEqual({
        declared: 5000,
        observed: 7800,
        comparisonAvailable: true,
        difference: 2800,
      });
      const down = buildSocialAccountComparison(
        ytEntry({ followersCount: 5000 }),
        null,
        observationView({ observedFollowersCount: 4200 }) as any,
      );
      expect(down.comparison.followers.difference).toBe(-800);
    });

    it("no declared count → no difference invented", () => {
      const c = buildSocialAccountComparison(
        ytEntry(),
        null,
        observationView({ observedFollowersCount: 27 }) as any,
      );
      expect(c.comparison.followers).toEqual({
        declared: null,
        observed: 27,
        comparisonAvailable: false,
        difference: null,
      });
    });

    it("observed 0 is a real count and is compared", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ followersCount: 300 }),
        null,
        observationView({ observedFollowersCount: 0 }) as any,
      );
      expect(c.comparison.followers).toEqual({
        declared: 300,
        observed: 0,
        comparisonAvailable: true,
        difference: -300,
      });
    });
  });

  describe("safety", () => {
    it("never mutates its inputs", () => {
      const entry = ytEntry({ followersCount: 5000 });
      const verification = {
        ownershipVerification: decided({
          status: "verified",
          decidedHandle: "x",
        }) as any,
      };
      const observation = observationView({ observedFollowersCount: 7800 });
      const snapshot = JSON.stringify([entry, verification, observation]);
      buildSocialAccountComparison(entry, verification, observation as any);
      expect(JSON.stringify([entry, verification, observation])).toBe(snapshot);
    });

    it("output carries no token-like or raw fields, even if inputs do", () => {
      const c = buildSocialAccountComparison(
        ytEntry({ accessToken: "EAAG-secret" }),
        null,
        observationView({ accessToken: "EAAG-secret", raw: { x: 1 } }) as any,
      );
      expect(JSON.stringify(c)).not.toContain("EAAG-secret");
      expect(JSON.stringify(c)).not.toContain("raw");
    });
  });
});

describe("SocialAccountComparisonService (Stage 3A-3)", () => {
  function setup() {
    const verification = {
      listForProfile: jest.fn((_t: string, _id: string, entries: any[]) =>
        Promise.resolve(
          entries.map((e) => ({
            socialAccountId: e.socialAccountId,
            ownershipVerification: decided({
              status: "verified",
              decidedHandle: e.handle,
            }),
            tierVerification: { status: "pending" },
          })),
        ),
      ),
      decide: jest.fn(),
      reconcile: jest.fn(),
    };
    const observation = {
      listForProfile: jest.fn((_t: string, _id: string, entries: any[]) =>
        Promise.resolve(
          entries.map((e) => ({
            ...observationView({}),
            socialAccountId: e.socialAccountId,
          })),
        ),
      ),
      observe: jest.fn(),
    };
    const service = new SocialAccountComparisonService(
      verification as any,
      observation as any,
    );
    return { service, verification, observation };
  }

  it("reads only through the 3A-1 / 3A-2 list methods — no platform call, no decision, no write", async () => {
    const { service, verification, observation } = setup();
    const entry = ytEntry();
    const snapshot = JSON.stringify(entry);
    const [c] = await service.compareProfile("Influencer", "inf-1", [entry]);

    expect(c.verified.ownership.status).toBe("verified");
    expect(c.observed.latest?.observedFollowersCount).toBe(27);
    expect(verification.listForProfile).toHaveBeenCalledWith(
      "Influencer",
      "inf-1",
      [entry],
    );
    expect(observation.listForProfile).toHaveBeenCalledWith(
      "Influencer",
      "inf-1",
      [entry],
    );
    expect(observation.observe).not.toHaveBeenCalled();
    expect(verification.decide).not.toHaveBeenCalled();
    expect(verification.reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(entry)).toBe(snapshot);
  });

  it("skips entries without a socialAccountId (no array-position identity) and pairs by id", async () => {
    const { service, verification } = setup();
    const other = ytEntry({
      socialAccountId: "64b0000000000000000000b2",
      handle: "second",
    });
    const list = await service.compareProfile("Influencer", "inf-1", [
      { platform: "YouTube", handle: "legacy" },
      other,
      ytEntry(),
    ]);
    expect(
      list.map((c) => [c.socialAccountId, c.verified.ownership.reviewedHandle]),
    ).toEqual([
      ["64b0000000000000000000b2", "second"],
      [ID, "rebuildwithsundeep"],
    ]);
    expect(
      (verification.listForProfile.mock.calls[0] as any[])[2],
    ).toHaveLength(2);
  });

  it("a profile with no identified accounts makes no lookups", async () => {
    const { service, verification, observation } = setup();
    expect(await service.compareProfile("Brand", "b-1", undefined)).toEqual([]);
    expect(verification.listForProfile).not.toHaveBeenCalled();
    expect(observation.listForProfile).not.toHaveBeenCalled();
  });

  it("compareAccount compares exactly the given account", async () => {
    const { service } = setup();
    const c = await service.compareAccount("Photographer", "ph-1", ytEntry());
    expect(c.socialAccountId).toBe(ID);
  });
});
