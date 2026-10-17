import {
  applyApprovedEligibilityFilter,
  applyDiscoverableProfileFilter,
  buildSearchRankingStages,
  getLocationPriorityTier,
  isDiscoverableProfile,
  profileVisibilityAllowsDiscovery,
} from "./profile-eligibility.util";

describe("profile-eligibility shared discovery policy", () => {
  const baseProfile = {
    status: "accepted",
    isDeleted: false,
    accountStatus: "active",
    isEmailVerified: true,
    isMobileVerified: true,
    verificationStatus: "approved",
    verifiedByTrendStarz: false,
    profileVisibility: "PUBLIC",
    profileImages: [{ url: "https://img", public_id: "x" }],
    location: { district: "Pune", state: "Maharashtra", country: "India" },
    socialMedia: [{ platform: "instagram", handle: "@creator", tier: "micro" }],
  };

  it("accepts only discoverable profiles", () => {
    expect(isDiscoverableProfile(baseProfile, { viewerIsAuthenticated: true })).toBe(true);
  });

  it("rejects email-only verified profile", () => {
    const profile = { ...baseProfile, isMobileVerified: false };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects mobile-only verified profile", () => {
    const profile = { ...baseProfile, isEmailVerified: false };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects admin-pending profile", () => {
    const profile = {
      ...baseProfile,
      verificationStatus: "pending",
      verifiedByTrendStarz: false,
    };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects admin-rejected profile", () => {
    const profile = {
      ...baseProfile,
      verificationStatus: "rejected",
      verifiedByTrendStarz: false,
    };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects inactive profile", () => {
    const profile = { ...baseProfile, status: "pending" };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects deleted profile", () => {
    const profile = { ...baseProfile, isDeleted: true };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("enforces guest visibility rules", () => {
    expect(profileVisibilityAllowsDiscovery("PUBLIC", false)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("MEMBERS_ONLY", false)).toBe(false);
    expect(profileVisibilityAllowsDiscovery("PRIVATE", false)).toBe(false);
  });

  it("enforces logged-in visibility rules", () => {
    expect(profileVisibilityAllowsDiscovery("PUBLIC", true)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("MEMBERS_ONLY", true)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("PRIVATE", true)).toBe(false);
  });

  it("builds discoverable query for guests vs logged in", () => {
    const guestFilter = applyDiscoverableProfileFilter({}, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated: false,
    });
    expect(guestFilter.profileVisibility).toEqual({ $nin: ["PRIVATE", "MEMBERS_ONLY"] });

    const memberFilter = applyDiscoverableProfileFilter({}, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated: true,
    });
    expect(memberFilter.profileVisibility).toEqual({ $nin: ["PRIVATE"] });
  });

  it("featured (requirePublic) excludes Members-Only even for logged-in viewers", () => {
    for (const viewerIsAuthenticated of [false, true]) {
      const filter = applyApprovedEligibilityFilter({}, {
        photoField: "profileImages",
        viewerIsAuthenticated,
        requirePremium: true,
        requirePublic: true,
      });
      expect(filter.profileVisibility).toEqual({ $nin: ["PRIVATE", "MEMBERS_ONLY"] });
      expect(filter.isPremium).toBe(true);
    }
  });

  it("applies location tier order district > state > country > remaining", () => {
    const viewer = { district: "Pune", state: "Maharashtra", country: "India" };

    const sameDistrict = {
      location: { district: "Pune", state: "Maharashtra", country: "India" },
    };
    const sameState = {
      location: { district: "Mumbai", state: "Maharashtra", country: "India" },
    };
    const sameCountry = {
      location: { district: "Bengaluru", state: "Karnataka", country: "India" },
    };
    const differentCountry = {
      location: { district: "Dubai", state: "Dubai", country: "UAE" },
    };

    expect(getLocationPriorityTier(sameDistrict, viewer)).toBe(4);
    expect(getLocationPriorityTier(sameState, viewer)).toBe(3);
    expect(getLocationPriorityTier(sameCountry, viewer)).toBe(2);
    expect(getLocationPriorityTier(differentCountry, viewer)).toBe(1);
  });
});

describe("approved active account rule (Stage 3B-1, shared by discovery and campaign alerts)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const util = require("./profile-eligibility.util");
  const approved = {
    status: "accepted",
    isDeleted: false,
    isEmailVerified: true,
    isMobileVerified: true,
    verificationStatus: "approved",
  };

  it.each([
    ["approved & active", approved, true],
    [
      "approved via verifiedByTrendStarz",
      {
        ...approved,
        verificationStatus: "pending",
        verifiedByTrendStarz: true,
      },
      true,
    ],
    ["pending review", { ...approved, verificationStatus: "pending" }, false],
    ["rejected", { ...approved, verificationStatus: "rejected" }, false],
    ["not accepted", { ...approved, status: "pending" }, false],
    ["deleted", { ...approved, isDeleted: true }, false],
    ["suspended (blocked)", { ...approved, accountStatus: "SUSPENDED" }, false],
    ["email unverified", { ...approved, isEmailVerified: false }, false],
    ["mobile unverified", { ...approved, isMobileVerified: false }, false],
  ])("%s → %s", (_label, profile, expected) => {
    expect(util.isApprovedActiveAccount(profile)).toBe(expected);
  });

  it("the DB filter expresses the same rule and keeps existing conditions", () => {
    const f = util.applyApprovedActiveAccountFilter({
      email: { $ne: "" },
      $and: [{ x: 1 }],
    });
    expect(f).toMatchObject({
      email: { $ne: "" },
      status: "accepted",
      isDeleted: { $ne: true },
      isEmailVerified: true,
      isMobileVerified: true,
    });
    expect(f.$and).toEqual([
      { x: 1 },
      {
        $or: [
          { verificationStatus: "approved" },
          { verifiedByTrendStarz: true },
        ],
      },
      {
        $or: [
          { accountStatus: { $exists: false } },
          { accountStatus: { $nin: ["suspended", "SUSPENDED"] } },
        ],
      },
    ]);
  });

  it("discoverability still requires the approval rule plus its own conditions", () => {
    const f = util.applyDiscoverableProfileFilter(
      {},
      { viewerIsAuthenticated: true },
    );
    expect(f.status).toBe("accepted");
    expect(JSON.stringify(f.$and)).toContain("verifiedByTrendStarz");
    expect(JSON.stringify(f.$and)).toContain("profileImages.0");
    expect(JSON.stringify(f.$and)).toContain("location.state");
    expect(
      util.isDiscoverableProfile({
        ...{
          status: "accepted",
          isEmailVerified: true,
          isMobileVerified: true,
          verificationStatus: "rejected",
        },
      }),
    ).toBe(false);
  });
});

describe("buildSearchRankingStages — response rate (Stage 3D-1c)", () => {
  const stages = buildSearchRankingStages(
    {},
    {
      invitesCollection: "campaigninvites",
      inviteMatchField: "influencerId",
      reviewsCollection: "reviews",
      reviewTargetType: "influencer",
    },
  );
  const lookup = stages.find(
    (s: any) => s.$lookup?.from === "campaigninvites",
  ).$lookup;
  const counted: string[] = lookup.pipeline[0].$match.status.$in;
  const acceptedCond = lookup.pipeline[1].$group.accepted.$sum.$cond[0];

  /** Same rule as the pipeline: accepted / (accepted + declined) over counted invites. */
  const rate = (statuses: string[]) => {
    const inScope = statuses.filter((s) => counted.includes(s));
    const accepted = inScope.filter((s) =>
      (acceptedCond.$in[1] as string[]).includes(s),
    ).length;
    return inScope.length ? Math.round((100 * accepted) / inScope.length) : 0;
  };

  it("counts invites that progressed after acceptance as accepted", () => {
    expect(acceptedCond).toEqual({
      $in: [
        "$status",
        expect.arrayContaining([
          "accepted",
          "payment_confirmed",
          "working",
          "submitted",
          "completed",
          "approved",
          "disputed",
        ]),
      ],
    });
  });

  it("a creator who completed 3 campaigns and declined 1 is 75%, not 0%", () => {
    expect(rate(["completed", "approved", "working", "declined"])).toBe(75);
  });

  it("unanswered, withdrawn and counter-offer invites are not counted either way", () => {
    for (const s of ["pending", "invited", "counter_sent", "withdrawn"]) {
      expect(counted).not.toContain(s);
    }
    expect(rate(["pending", "withdrawn"])).toBe(0);
  });
});
