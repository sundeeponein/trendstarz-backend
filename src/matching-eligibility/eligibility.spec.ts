import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { aggregateOverall, evaluateEligibility } from "./eligibility";
import { MatchingEligibilityController } from "./matching-eligibility.controller";
import { MatchingEligibilityService } from "./matching-eligibility.service";

// Fixtures go through the real Stage 3B-1 normalizers (no raw-field reading in 3B-2).
const rawCreator = (over: Record<string, any> = {}) => ({
  _id: "inf-1",
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  profileImages: [{ url: "x" }],
  location: { state: "Telangana", district: "Hyderabad" },
  categories: ["Fashion", "Lifestyle"],
  languages: ["Telugu", "English"],
  socialMedia: [
    {
      socialAccountId: "64b0000000000000000000a1",
      platformKey: "instagram",
      platform: "Instagram",
      handle: "creator",
      tier: "Macro",
      contentTypes: [
        { name: "Reel", enabled: true, price: 1500 },
        { name: "Photo post", enabled: false, price: 800 },
      ],
    },
  ],
  ...over,
});

const rawCampaign = (over: Record<string, any> = {}) => ({
  _id: "camp-1",
  status: "draft",
  campaignMode: "invite_only",
  ownerType: "brand",
  inviteRecipientRole: "influencer",
  platforms: ["Instagram"],
  categories: ["Fashion"],
  socialMedia: [
    {
      platform: "Instagram",
      contentTypes: [
        { name: "Reel", enabled: true, price: 1000 },
        { name: "Photo post", enabled: false, price: null },
      ],
    },
  ],
  minInfluencerTier: "Micro",
  targetState: "Telangana",
  targetDistrict: "Hyderabad",
  targetCities: ["Hyderabad"],
  languages: ["Telugu"],
  ...over,
});

const evaluate = (
  campaignOver: Record<string, any> = {},
  creatorOver: Record<string, any> = {},
  type: "Influencer" | "Photographer" = "Influencer",
) =>
  evaluateEligibility(
    normalizeCampaignMatchInput(rawCampaign(campaignOver)),
    normalizeCreatorMatchInput(rawCreator(creatorOver), type),
  );

describe("Stage 3B-2 deterministic eligibility", () => {
  it("a creator meeting every requirement → overall PASS, with reasons", () => {
    const r = evaluate();
    expect(r.overall).toBe("PASS");
    expect(r.requirements.accountApproval).toMatchObject({
      status: "PASS",
      reason: "Creator is approved and active.",
    });
    expect(r.requirements.platformContent).toMatchObject({
      status: "PASS",
      reason: "Creator supports instagram:reel.",
    });
    expect(r.requirements.minimumTier).toMatchObject({
      status: "PASS",
      reason: "Creator tier Macro meets the minimum Micro tier.",
    });
    expect(r.requirements.location).toMatchObject({
      status: "PASS",
      reason:
        "Creator location matches state Telangana and district Hyderabad.",
    });
    expect(r.requirements.language.status).toBe("PASS");
    expect(r.requirements.category.status).toBe("PASS");
  });

  describe("account approval (shared Stage 3B-1 rule)", () => {
    it.each([
      [{}, "PASS", "Creator is approved and active."],
      [
        { verificationStatus: "pending" },
        "FAIL",
        "Creator is not approved yet (verification: pending).",
      ],
      [
        { verificationStatus: "rejected" },
        "FAIL",
        "Creator approval status is rejected.",
      ],
      [{ accountStatus: "SUSPENDED" }, "FAIL", "Creator account is suspended."],
      [{ isDeleted: true }, "FAIL", "Creator account is deleted."],
      [
        { status: "pending" },
        "FAIL",
        "Creator account is not accepted (status: pending).",
      ],
      [
        { isMobileVerified: false },
        "FAIL",
        "Creator email or mobile number is not verified.",
      ],
    ])("%j → %s", (over, status, reason) => {
      expect(evaluate({}, over).requirements.accountApproval).toMatchObject({
        status,
        reason,
      });
    });
  });

  describe("creator type vs recipient role", () => {
    it("an influencer on a photographer campaign fails", () => {
      expect(
        evaluate({ inviteRecipientRole: "photographer" }).requirements
          .creatorType.status,
      ).toBe("FAIL");
    });
  });

  describe("platform + content (any ONE enabled canonical pair)", () => {
    it("exact canonical pair → PASS", () => {
      expect(evaluate().requirements.platformContent.status).toBe("PASS");
    });
    it("mismatched platform → FAIL", () => {
      const r = evaluate({
        platforms: ["YouTube"],
        socialMedia: [
          {
            platform: "YouTube",
            contentTypes: [{ name: "Shorts", enabled: true }],
          },
        ],
      });
      expect(r.requirements.platformContent).toMatchObject({
        status: "FAIL",
        reason:
          "Creator does not support any of the required platform/content combinations.",
      });
    });
    it("same platform, content type the creator doesn't offer → FAIL (Photo post is disabled for the creator)", () => {
      const r = evaluate({
        socialMedia: [
          {
            platform: "Instagram",
            contentTypes: [{ name: "Photo post", enabled: true }],
          },
        ],
      });
      expect(r.requirements.platformContent.status).toBe("FAIL");
    });
    it("one of several options is enough", () => {
      const r = evaluate({
        platforms: ["YouTube", "Instagram"],
        socialMedia: [
          {
            platform: "YouTube",
            contentTypes: [{ name: "Shorts", enabled: true }],
          },
          {
            platform: "Instagram",
            contentTypes: [{ name: "Reel", enabled: true }],
          },
        ],
      });
      expect(r.requirements.platformContent.status).toBe("PASS");
    });
    it("an ambiguous (null-key) requirement never creates a false PASS", () => {
      const tiktok = {
        socialMedia: [
          {
            platform: "TikTok",
            contentTypes: [{ name: "Video", enabled: true }],
          },
        ],
        platforms: ["TikTok"],
      };
      const creatorWithTikTok = {
        socialMedia: [
          {
            platformKey: "tiktok",
            platform: "TikTok",
            tier: "Micro",
            contentTypes: [{ name: "Video", enabled: true }],
          },
        ],
      };
      expect(
        evaluate(tiktok, creatorWithTikTok).requirements.platformContent.status,
      ).toBe("UNKNOWN");
    });
    it("no content and no platforms configured → PASS (not configured)", () => {
      expect(
        evaluate({ socialMedia: [], platforms: [] }).requirements
          .platformContent,
      ).toMatchObject({
        status: "PASS",
        configured: false,
        reason: "No platform/content requirement is configured.",
      });
    });
    it("platforms but no content toggles → platform account check", () => {
      expect(
        evaluate({ socialMedia: [], platforms: ["Instagram"] }).requirements
          .platformContent.status,
      ).toBe("PASS");
      expect(
        evaluate({ socialMedia: [], platforms: ["YouTube"] }).requirements
          .platformContent.status,
      ).toBe("FAIL");
    });
  });

  describe("category", () => {
    it("matching → PASS; no overlap → FAIL; missing creator categories → UNKNOWN; none required → PASS", () => {
      expect(evaluate().requirements.category.status).toBe("PASS");
      expect(
        evaluate({ categories: ["Tech"] }).requirements.category.status,
      ).toBe("FAIL");
      expect(
        evaluate({}, { categories: [] }).requirements.category,
      ).toMatchObject({
        status: "UNKNOWN",
        reason: "Creator category information is unavailable.",
      });
      expect(evaluate({ categories: [] }).requirements.category).toMatchObject({
        status: "PASS",
        configured: false,
      });
    });
    it("photographer-owned campaigns use the normalized target categories, not the owner's services", () => {
      const owned = {
        ownerType: "photographer",
        categories: ["Wedding"],
        targetTiers: ["Fashion"],
      };
      expect(evaluate(owned).requirements.category.status).toBe("PASS");
      expect(
        evaluate({ ...owned, targetTiers: ["Tech"] }).requirements.category
          .status,
      ).toBe("FAIL");
    });
  });

  describe("minimum tier (canonical order, campaign platforms, declared tier only)", () => {
    it.each([
      ["Macro", "PASS", "Creator tier Macro meets the minimum Micro tier."],
      ["Micro", "PASS", "Creator tier Micro meets the minimum Micro tier."],
      [
        "Starter",
        "FAIL",
        "Creator tier Starter does not meet the minimum Micro tier.",
      ],
      [
        "mid tier",
        "PASS",
        "Creator tier Mid-Tier meets the minimum Micro tier.",
      ],
    ])("creator %s → %s", (tier, status, reason) => {
      const r = evaluate(
        {},
        { socialMedia: [{ ...rawCreator().socialMedia[0], tier }] },
      );
      expect(r.requirements.minimumTier).toMatchObject({ status, reason });
    });
    it("unknown creator tier → UNKNOWN", () => {
      const r = evaluate(
        {},
        { socialMedia: [{ ...rawCreator().socialMedia[0], tier: "" }] },
      );
      expect(r.requirements.minimumTier.status).toBe("UNKNOWN");
    });
    it("only accounts on the campaign's platforms count", () => {
      const creator = {
        socialMedia: [
          {
            platformKey: "youtube",
            platform: "YouTube",
            tier: "Mega / Celebrity",
            contentTypes: [],
          },
          { ...rawCreator().socialMedia[0], tier: "Nano" },
        ],
      };
      expect(evaluate({}, creator).requirements.minimumTier.status).toBe(
        "FAIL",
      );
    });
    it("no account on the campaign platforms → UNKNOWN for tier (platform check fails separately)", () => {
      const r = evaluate(
        {},
        {
          socialMedia: [
            {
              platformKey: "youtube",
              platform: "YouTube",
              tier: "Macro",
              contentTypes: [],
            },
          ],
        },
      );
      expect(r.requirements.minimumTier.status).toBe("UNKNOWN");
      expect(r.requirements.platformContent.status).toBe("FAIL");
      expect(r.overall).toBe("FAIL");
    });
    it("no minimum tier → PASS (not configured)", () => {
      expect(
        evaluate({ minInfluencerTier: "" }).requirements.minimumTier,
      ).toMatchObject({ status: "PASS", configured: false });
    });
    it("observed followers / verification never change the tier result", () => {
      const r = evaluateEligibility(
        normalizeCampaignMatchInput(rawCampaign()),
        normalizeCreatorMatchInput(
          rawCreator({
            socialMedia: [{ ...rawCreator().socialMedia[0], tier: "Nano" }],
          }),
          "Influencer",
          {
            verification: new Map([
              [
                "64b0000000000000000000a1",
                { ownership: "verified", tier: "verified" },
              ],
            ]),
            observation: new Map([
              [
                "64b0000000000000000000a1",
                { available: true, followersAvailable: true },
              ],
            ]),
          },
        ),
      );
      expect(r.requirements.minimumTier.status).toBe("FAIL");
      expect(r.evidence.accountsOnCampaignPlatforms[0]).toMatchObject({
        tierVerificationStatus: "verified",
        observationAvailable: true,
      });
    });
  });

  describe("location (explicit state/district only)", () => {
    it("state + district match → PASS", () => {
      expect(evaluate().requirements.location.status).toBe("PASS");
    });
    it("state mismatch → FAIL with both values", () => {
      expect(
        evaluate(
          {},
          { location: { state: "Karnataka", district: "Bengaluru Urban" } },
        ).requirements.location,
      ).toMatchObject({
        status: "FAIL",
        reason: expect.stringContaining(
          "Campaign requires Telangana; creator is in Karnataka.",
        ),
      });
    });
    it("a state mismatch is the only reason given (districts are not compared across states)", () => {
      expect(
        evaluate({}, { location: { state: "Goa", district: "North Goa" } })
          .requirements.location.reason,
      ).toBe("Campaign requires Telangana; creator is in Goa.");
    });
    it("district mismatch → FAIL", () => {
      expect(
        evaluate({}, { location: { state: "Telangana", district: "Warangal" } })
          .requirements.location,
      ).toMatchObject({
        status: "FAIL",
        reason: "Campaign requires district Hyderabad; creator is in Warangal.",
      });
    });
    it("missing creator district → UNKNOWN (never PASS)", () => {
      expect(
        evaluate({}, { location: { state: "Telangana" } }).requirements
          .location,
      ).toMatchObject({
        status: "UNKNOWN",
        reason: "Creator district is unavailable.",
      });
    });
    it("missing creator state → UNKNOWN", () => {
      expect(
        evaluate(
          { targetDistrict: undefined, targetCities: [] },
          { location: {} },
        ).requirements.location,
      ).toMatchObject({
        status: "UNKNOWN",
        reason: "Creator state is unavailable.",
      });
    });
    it("state-only requirement ignores the creator's district", () => {
      expect(
        evaluate(
          { targetDistrict: undefined, targetCities: [] },
          { location: { state: "Telangana" } },
        ).requirements.location.status,
      ).toBe("PASS");
    });
    it("no location requirement → PASS (not configured)", () => {
      expect(
        evaluate({
          targetState: undefined,
          targetDistrict: undefined,
          targetCities: [],
        }).requirements.location,
      ).toMatchObject({
        status: "PASS",
        configured: false,
      });
    });
  });

  describe("language", () => {
    it("overlap → PASS; no overlap → FAIL; no creator languages → UNKNOWN; none required → PASS", () => {
      expect(evaluate().requirements.language.status).toBe("PASS");
      expect(
        evaluate({}, { languages: ["Hindi"] }).requirements.language.status,
      ).toBe("FAIL");
      expect(
        evaluate({}, { languages: [] }).requirements.language,
      ).toMatchObject({
        status: "UNKNOWN",
        reason: "Creator language information is unavailable.",
      });
      expect(evaluate({ languages: [] }).requirements.language).toMatchObject({
        status: "PASS",
        configured: false,
      });
    });
  });

  describe("overall", () => {
    const r = (status: "PASS" | "FAIL" | "UNKNOWN") => ({
      status,
      reason: "",
      configured: true,
    });
    it("all PASS → PASS; any FAIL → FAIL; no FAIL but an UNKNOWN → UNKNOWN", () => {
      expect(aggregateOverall([r("PASS"), r("PASS")])).toBe("PASS");
      expect(aggregateOverall([r("PASS"), r("UNKNOWN"), r("FAIL")])).toBe(
        "FAIL",
      );
      expect(aggregateOverall([r("PASS"), r("UNKNOWN")])).toBe("UNKNOWN");
    });
    it("unconfigured requirements PASS; one missing datum makes the whole result UNKNOWN", () => {
      const bare = evaluate({
        minInfluencerTier: "",
        languages: [],
        targetState: undefined,
        targetDistrict: undefined,
        targetCities: [],
      });
      expect(bare.overall).toBe("PASS");
      expect(evaluate({}, { languages: [] }).overall).toBe("UNKNOWN");
    });
  });

  describe("photographer-recipient campaigns", () => {
    it("services-based fields are reported UNKNOWN, never guessed", () => {
      const r = evaluate(
        {
          inviteRecipientRole: "photographer",
          platforms: ["Wedding Shoot"],
          socialMedia: [],
          categories: ["Wedding"],
          minInfluencerTier: "",
          languages: [],
        },
        { skills: ["Wedding"], socialMedia: [] },
        "Photographer",
      );
      expect(r.requirements.creatorType.status).toBe("PASS");
      expect(r.requirements.platformContent.status).toBe("UNKNOWN");
      expect(r.requirements.category.status).toBe("UNKNOWN");
      expect(r.overall).toBe("UNKNOWN");
    });
  });

  it("documents what is deliberately not evaluated", () => {
    expect(evaluate().notEvaluated.map((n) => n.input)).toEqual([
      "followerRange",
      "budget",
      "availability",
      "dates",
      "verification / observation",
    ]);
  });

  it("never mutates the normalized inputs; output has no scores or weights", () => {
    const campaign = normalizeCampaignMatchInput(rawCampaign());
    const creator = normalizeCreatorMatchInput(rawCreator(), "Influencer");
    const snapshot = JSON.stringify([campaign, creator]);
    const result = evaluateEligibility(campaign, creator);
    expect(JSON.stringify([campaign, creator])).toBe(snapshot);
    for (const banned of ["score", "weight", "rank", "trendScore"]) {
      expect(JSON.stringify(result).toLowerCase()).not.toContain(
        banned.toLowerCase(),
      );
    }
  });
});

describe("MatchingEligibilityService / Controller", () => {
  it("loads both normalized inputs through the read-only 3B-1 service and evaluates them", async () => {
    const inputs = {
      forCampaign: jest
        .fn()
        .mockResolvedValue(normalizeCampaignMatchInput(rawCampaign())),
      forCreator: jest
        .fn()
        .mockResolvedValue(
          normalizeCreatorMatchInput(rawCreator(), "Influencer"),
        ),
    };
    const invites = { invitedRecipientIds: jest.fn() };
    const result = await new MatchingEligibilityService(
      inputs as any,
      invites as any,
    ).evaluate("camp-1", "influencer", "inf-1");
    expect(inputs.forCampaign).toHaveBeenCalledWith("camp-1");
    expect(inputs.forCreator).toHaveBeenCalledWith("influencer", "inf-1");
    expect(result.overall).toBe("PASS");
  });

  it("is GET admin/matching/eligibility/:campaignId/:creatorType/:creatorId behind JwtAuthGuard + RolesGuard", () => {
    expect(Reflect.getMetadata("path", MatchingEligibilityController)).toBe(
      "admin/matching",
    );
    expect(
      Reflect.getMetadata(
        "path",
        Object.getOwnPropertyDescriptor(
          MatchingEligibilityController.prototype,
          "eligibility",
        )?.value,
      ),
    ).toBe("eligibility/:campaignId/:creatorType/:creatorId");
    expect(
      Reflect.getMetadata("__guards__", MatchingEligibilityController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });

  const ctx = (user: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as any;

  it("admin and subadmin allowed; creators and brands refused; unauthenticated refused", async () => {
    const roles = new RolesGuard();
    expect(roles.canActivate(ctx({ role: "admin" }))).toBe(true);
    expect(roles.canActivate(ctx({ role: "subadmin" }))).toBe(true);
    for (const role of ["influencer", "brand", "photographer"]) {
      expect(() => roles.canActivate(ctx({ role }))).toThrow(
        ForbiddenException,
      );
    }
    const jwtGuard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as any,
      { models: {} } as any,
    );
    await expect(jwtGuard.canActivate(ctx(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
