import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MatchingInputsController } from "./matching-inputs.controller";
import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "./matching-inputs";
import { MatchingInputsService } from "./matching-inputs.service";

const ID_IG = "64b0000000000000000000a1";
const ID_YT = "64b0000000000000000000b2";

const creator = (over: Record<string, any> = {}) => ({
  _id: "inf-1",
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  profileImages: [{ url: "x" }],
  location: { state: "Telangana", district: "Hyderabad" },
  categories: ["Fashion", "Food", "fashion "],
  languages: ["Telugu", "English"],
  collaborationAvailability: { enabled: true },
  lastLoginAt: "2026-09-30T10:00:00.000Z",
  socialMedia: [
    {
      socialAccountId: ID_IG,
      platformKey: "instagram",
      platform: "Instagram",
      handle: "creator",
      tier: "Micro",
      followersCount: 0,
      contentTypes: [
        { name: "Reel", enabled: true, price: 1500 },
        { name: "Photo post", enabled: false, price: 800 },
        { name: "Story (24h)", enabled: true, price: 0 },
      ],
    },
    {
      socialAccountId: ID_YT,
      platformKey: "youtube",
      platform: "YouTube",
      handle: "creatortube",
      tier: "Mid tier",
      contentTypes: [{ name: "Shorts", enabled: true, price: 1000 }],
    },
  ],
  ...over,
});

describe("normalizeCreatorMatchInput (Stage 3B-1)", () => {
  it("builds the normalized creator input from stored data, keeping originals", () => {
    const n = normalizeCreatorMatchInput(creator(), "Influencer");
    expect(n.creatorId).toBe("inf-1");
    expect(n.platforms).toEqual(["instagram", "youtube"]);
    expect(n.categories).toEqual(["Fashion", "Food"]); // de-duplicated, original spelling kept
    expect(n.contentTypes).toEqual([
      "instagram:reel",
      "instagram:story",
      "youtube:shorts",
    ]);
    expect(n.rates).toEqual(
      expect.arrayContaining([
        {
          platformKey: "instagram",
          originalPlatform: "Instagram",
          originalContentType: "Reel",
          canonicalContentTypeKey: "reel",
          enabled: true,
          priceRupees: 1500,
          priceConfirmedAt: null,
        },
        expect.objectContaining({
          originalContentType: "Photo post",
          enabled: false,
          priceRupees: 800,
        }),
        expect.objectContaining({
          originalContentType: "Story (24h)",
          priceRupees: null,
        }),
      ]),
    );
    expect(n.accounts[1]).toMatchObject({
      platformKey: "youtube",
      declaredTier: { key: "mid_tier", label: "Mid-Tier" },
      originalTier: "Mid tier",
    });
    expect(n.location).toEqual({ state: "Telangana", district: "Hyderabad" });
    expect(n.languages).toEqual(["Telugu", "English"]);
    expect(n.availability).toBe(true);
    expect(n.lastActiveAt).toEqual(new Date("2026-09-30T10:00:00.000Z"));
  });

  it.each([
    ["approved active", {}, true],
    ["pending", { verificationStatus: "pending" }, false],
    ["rejected", { verificationStatus: "rejected" }, false],
    ["deleted", { isDeleted: true }, false],
    ["blocked (suspended)", { accountStatus: "suspended" }, false],
    ["not accepted", { status: "pending" }, false],
  ])("eligibility: %s → approvedActiveAccount %s", (_l, over, expected) => {
    expect(
      normalizeCreatorMatchInput(creator(over), "Influencer").eligibility
        .approvedActiveAccount,
    ).toBe(expected);
  });

  it("discoverability is reported separately from approval", () => {
    const n = normalizeCreatorMatchInput(
      creator({ profileVisibility: "PRIVATE" }),
      "Influencer",
    );
    expect(n.eligibility).toMatchObject({
      approvedActiveAccount: true,
      discoverable: false,
    });
  });

  it("evidence is attached per socialAccountId — states only, no weights", () => {
    const n = normalizeCreatorMatchInput(creator(), "Influencer", {
      verification: new Map([
        [ID_IG, { ownership: "verified", tier: "rejected" }],
      ]),
      observation: new Map([
        [ID_YT, { available: true, followersAvailable: false }],
      ]),
    });
    expect(n.accounts[0].evidence).toEqual({
      ownershipVerificationStatus: "verified",
      tierVerificationStatus: "rejected",
      observationAvailable: false,
      observedFollowersAvailable: false,
    });
    expect(n.accounts[1].evidence).toEqual({
      ownershipVerificationStatus: "pending",
      tierVerificationStatus: "pending",
      observationAvailable: true,
      observedFollowersAvailable: false,
    });
    // No scores, TrendScore or history metrics in the contract.
    const keys = JSON.stringify(n);
    for (const banned of [
      "score",
      "trendScore",
      "acceptanceRate",
      "responseRate",
      "completionRate",
      "weight",
    ]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("handles missing optional fields and unknown platforms / tiers", () => {
    const n = normalizeCreatorMatchInput(
      {
        _id: "x",
        socialMedia: [
          {
            platform: "Snapchat",
            tier: "Gold",
            contentTypes: [{ name: "Snap", enabled: true }],
          },
        ],
      },
      "Influencer",
    );
    expect(n.platforms).toEqual([]);
    expect(n.accounts[0]).toMatchObject({
      platformKey: null,
      declaredTier: null,
      originalTier: "Gold",
      socialAccountId: null,
    });
    expect(n.contentTypes).toEqual([]);
    expect(n.location).toEqual({ state: null, district: null });
    expect(n.languages).toEqual([]);
    expect(n.availability).toBeNull();
    expect(n.lastActiveAt).toBeNull();
  });

  it("photographers use skills as their categories", () => {
    const n = normalizeCreatorMatchInput(
      { _id: "p", skills: ["Wedding", "Drone"], socialMedia: [] },
      "Photographer",
    );
    expect(n.categories).toEqual(["Wedding", "Drone"]);
  });

  it("never mutates the source profile", () => {
    const p = creator();
    const snapshot = JSON.stringify(p);
    normalizeCreatorMatchInput(p, "Influencer", {
      verification: new Map(),
      observation: new Map(),
    });
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

const campaign = (over: Record<string, any> = {}) => ({
  _id: "c1",
  status: "active",
  campaignMode: "invite_only",
  campaignType: "paid_collab",
  ownerType: "brand",
  inviteRecipientRole: "influencer",
  platforms: ["YouTube", "Instagram"],
  categories: ["Fashion", "Travel"],
  deliverables: ["1 Reel or", "Or"],
  socialMedia: [
    {
      platform: "YouTube",
      contentTypes: [
        { name: "Video", enabled: false, price: 5000 },
        { name: "Shorts", enabled: true, price: 1000 },
      ],
    },
    {
      platform: "Instagram",
      contentTypes: [
        { name: "Reel", enabled: true, price: 1000 },
        { name: "Photo post", enabled: false, price: null },
      ],
    },
  ],
  minInfluencerTier: "Micro",
  targetTiers: ["Micro", "mid tier"],
  targetState: "Telangana",
  targetCities: ["Hyderabad"],
  languages: ["Telugu"],
  pricePerInfluencer: 200000,
  estimatedBudget: 1000000,
  budgetMin: 10000,
  budgetMax: 10000,
  startDate: "2026-10-01T00:00:00.000Z",
  endDate: "2026-10-15T00:00:00.000Z",
  acceptanceDeadline: "2026-10-03T00:00:00.000Z",
  ...over,
});

describe("normalizeCampaignMatchInput (Stage 3B-1)", () => {
  it("builds structured requirements from existing fields", () => {
    const n = normalizeCampaignMatchInput(campaign());
    expect(n.platforms).toEqual([
      { platformKey: "youtube", original: "YouTube" },
      { platformKey: "instagram", original: "Instagram" },
    ]);
    expect(n.categories).toEqual(["Fashion", "Travel"]);
    expect(n.contentTypes).toEqual(["youtube:shorts", "instagram:reel"]);
    // Structured deliverables are the enabled toggles; free text is never interpreted.
    expect(
      n.structuredDeliverables.map((d) => [
        d.originalContentType,
        d.canonicalContentTypeKey,
        d.priceRupees,
      ]),
    ).toEqual([
      ["Shorts", "shorts", 1000],
      ["Reel", "reel", 1000],
    ]);
    expect(n.freeTextDeliverables).toEqual(["1 Reel or", "Or"]);
    expect(n.minimumTier).toEqual({ key: "micro", label: "Micro" });
    expect(n.targetTiers).toEqual([
      { key: "micro", label: "Micro" },
      { key: "mid_tier", label: "Mid-Tier" },
    ]);
    expect(n.languages).toEqual(["Telugu"]);
  });

  it("location: the district the form saves into targetCities[0] is labelled as such", () => {
    expect(normalizeCampaignMatchInput(campaign()).location).toEqual({
      state: "Telangana",
      district: "Hyderabad",
      districtSource: "targetCities",
      cities: ["Hyderabad"],
    });
    expect(
      normalizeCampaignMatchInput(campaign({ targetDistrict: "Warangal" }))
        .location,
    ).toMatchObject({
      district: "Warangal",
      districtSource: "targetDistrict",
    });
    expect(
      normalizeCampaignMatchInput(
        campaign({ targetState: undefined, targetCities: [] }),
      ).location,
    ).toEqual({
      state: null,
      district: null,
      districtSource: null,
      cities: [],
    });
  });

  it("photographer campaigns use the venue; photographer-owned targetTiers are categories, not tiers", () => {
    const n = normalizeCampaignMatchInput(
      campaign({
        ownerType: "photographer",
        inviteRecipientRole: "photographer",
        targetTiers: ["Fashion", "Beauty"],
        venueState: "Karnataka",
        venueDistrict: "Bengaluru Urban",
      }),
    );
    expect(n.targetTiers).toEqual([]);
    expect(n.targetCreatorCategories).toEqual(["Fashion", "Beauty"]);
    expect(n.location).toMatchObject({
      state: "Karnataka",
      district: "Bengaluru Urban",
      districtSource: "venueDistrict",
    });
  });

  it("budget: per-deliverable INR prices vs per-creator/total paise are kept apart", () => {
    expect(normalizeCampaignMatchInput(campaign()).budget).toEqual({
      perDeliverableCurrency: "INR",
      pricePerCreatorPaise: 200000,
      estimatedTotalPaise: 1000000,
      budgetMinRupees: 10000,
      budgetMaxRupees: 10000,
    });
  });

  it("backward compatible: an old campaign without the new fields normalizes cleanly", () => {
    const n = normalizeCampaignMatchInput({
      _id: "old",
      platforms: ["Instagram"],
      categories: ["Food"],
    });
    expect(n).toMatchObject({
      minimumTier: null,
      targetTiers: [],
      languages: [],
      structuredDeliverables: [],
      followerRange: { min: null, max: null, enforced: false },
      dates: { start: null, end: null, acceptanceDeadline: null },
    });
  });

  it("an invalid tier value is reported as no tier (never guessed)", () => {
    expect(
      normalizeCampaignMatchInput(
        campaign({ minInfluencerTier: "Gold", targetTiers: ["Platinum"] }),
      ),
    ).toMatchObject({
      minimumTier: null,
      targetTiers: [],
    });
  });

  it("never mutates the source campaign", () => {
    const c = campaign();
    const snapshot = JSON.stringify(c);
    normalizeCampaignMatchInput(c);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe("MatchingInputsService (read-only)", () => {
  function setup(doc: any) {
    const readOnlyModel = () => {
      const lean = jest.fn().mockResolvedValue(doc);
      return new Proxy(
        { findById: jest.fn(() => ({ lean })) },
        {
          get(t: any, p: string) {
            if (p in t) return t[p];
            throw new Error(`unexpected model operation: ${p}`);
          },
        },
      );
    };
    const verification = {
      listForProfile: jest.fn().mockResolvedValue([]),
      decide: jest.fn(),
      reconcile: jest.fn(),
    };
    const observation = {
      listForProfile: jest.fn().mockResolvedValue([]),
      observe: jest.fn(),
    };
    const service = new MatchingInputsService(
      readOnlyModel(),
      readOnlyModel(),
      readOnlyModel(),
      verification as any,
      observation as any,
    );
    return { service, verification, observation };
  }

  it("reads a creator and its evidence through read methods only", async () => {
    const { service, verification, observation } = setup(creator());
    const n = await service.forCreator(
      "influencer",
      "64b0000000000000000000ff",
    );
    expect(n.platforms).toEqual(["instagram", "youtube"]);
    expect(verification.listForProfile).toHaveBeenCalled();
    expect(observation.listForProfile).toHaveBeenCalled();
    expect(verification.decide).not.toHaveBeenCalled();
    expect(verification.reconcile).not.toHaveBeenCalled();
    expect(observation.observe).not.toHaveBeenCalled();
  });

  it("validates ids and types; 404 when missing", async () => {
    await expect(
      setup(null).service.forCreator("brand", "64b0000000000000000000ff"),
    ).rejects.toThrow("type must be");
    await expect(
      setup(null).service.forCreator("influencer", "nope"),
    ).rejects.toThrow("Invalid id");
    await expect(
      setup(null).service.forCreator("influencer", "64b0000000000000000000ff"),
    ).rejects.toThrow("Creator not found");
    await expect(
      setup(null).service.forCampaign("64b0000000000000000000ff"),
    ).rejects.toThrow("Campaign not found");
  });

  it("is admin-only", () => {
    expect(Reflect.getMetadata("__guards__", MatchingInputsController)).toEqual(
      [JwtAuthGuard, RolesGuard],
    );
    expect(Reflect.getMetadata("path", MatchingInputsController)).toBe(
      "admin/matching-inputs",
    );
  });
});

describe("T1 — district provenance in the normalized campaign input", () => {
  it("new saves (targetDistrict + legacy mirror) report targetDistrict as the source", () => {
    expect(
      normalizeCampaignMatchInput(
        campaign({ targetDistrict: "Hyderabad", targetCities: ["Hyderabad"] }),
      ).location,
    ).toEqual({
      state: "Telangana",
      district: "Hyderabad",
      districtSource: "targetDistrict",
      cities: ["Hyderabad"],
    });
  });

  it("legacy campaigns with only targetCities[0] stay readable, labelled as legacy", () => {
    expect(
      normalizeCampaignMatchInput(
        campaign({ targetDistrict: undefined, targetCities: ["Hyderabad"] }),
      ).location,
    ).toMatchObject({
      district: "Hyderabad",
      districtSource: "targetCities",
    });
  });

  it("targetDistrict wins over a different legacy value; several cities are never guessed into a district", () => {
    expect(
      normalizeCampaignMatchInput(
        campaign({ targetDistrict: "Warangal", targetCities: ["Hyderabad"] }),
      ).location.district,
    ).toBe("Warangal");
    expect(
      normalizeCampaignMatchInput(
        campaign({
          targetDistrict: undefined,
          targetCities: ["Hyderabad", "Warangal"],
        }),
      ).location,
    ).toMatchObject({ district: null, districtSource: null });
  });
});
