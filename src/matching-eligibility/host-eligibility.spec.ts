import { ForbiddenException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { evaluateEligibility } from "./eligibility";
import { HostCampaignEligibilityController } from "./host-campaign-eligibility.controller";
import {
  buildHostEligibilityView,
  toHostCreatorEligibility,
} from "./host-eligibility";
import { MatchingEligibilityService } from "./matching-eligibility.service";

const rawCreator = (id: string, over: Record<string, any> = {}) => ({
  _id: id,
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  location: { state: "Telangana", district: "Hyderabad" },
  categories: ["Fashion"],
  languages: ["Telugu"],
  socialMedia: [
    {
      platformKey: "instagram",
      platform: "Instagram",
      tier: "Macro",
      contentTypes: [{ name: "Reel", enabled: true, price: 1500 }],
    },
  ],
  ...over,
});

const rawCampaign = (over: Record<string, any> = {}) => ({
  _id: "camp-1",
  status: "active",
  ownerType: "brand",
  inviteRecipientRole: "influencer",
  platforms: ["Instagram"],
  categories: ["Fashion"],
  socialMedia: [
    {
      platform: "Instagram",
      contentTypes: [{ name: "Reel", enabled: true, price: 1000 }],
    },
  ],
  minInfluencerTier: "Micro",
  targetState: "Telangana",
  targetDistrict: "Hyderabad",
  languages: ["Telugu"],
  ...over,
});

const campaign = normalizeCampaignMatchInput(rawCampaign());
const evaluate = (id: string, over: Record<string, any> = {}) =>
  evaluateEligibility(
    campaign,
    normalizeCreatorMatchInput(rawCreator(id, over), "Influencer"),
  );

describe("Stage 3B-4 host eligibility projection", () => {
  it("meets / not_met / needs_info with requirement labels only", () => {
    expect(toHostCreatorEligibility(evaluate("a"))).toEqual({
      status: "meets",
      notMet: [],
      needsInfo: [],
    });
    expect(
      toHostCreatorEligibility(
        evaluate("b", {
          categories: ["Food"],
          location: { state: "Kerala", district: "Kochi" },
        }),
      ),
    ).toEqual({
      status: "not_met",
      notMet: ["Category", "Location"],
      needsInfo: [],
    });
    expect(toHostCreatorEligibility(evaluate("c", { languages: [] }))).toEqual({
      status: "needs_info",
      notMet: [],
      needsInfo: ["Language"],
    });
  });

  it("never sends reasons or creator data, and leaves out unapproved creators", () => {
    const view = buildHostEligibilityView(campaign, [
      evaluate("a"),
      evaluate("b", { location: { state: "Kerala", district: "Kochi" } }),
      evaluate("pending", { verificationStatus: "pending" }),
      evaluate("unverified", { isMobileVerified: false }),
    ]);
    expect(Object.keys(view.creators)).toEqual(["a", "b"]);
    const json = JSON.stringify(view);
    for (const leak of [
      "Kerala",
      "Kochi",
      "pending",
      "verified",
      "mobile",
      "reason",
      "Approval",
    ])
      expect(json).not.toContain(leak);
  });

  it("lists the requirements the campaign sets", () => {
    expect(
      buildHostEligibilityView(campaign, [evaluate("a")]).configured,
    ).toEqual([
      "Creator type",
      "Platform / content",
      "Category",
      "Tier",
      "Location",
      "Language",
    ]);
    const loose = normalizeCampaignMatchInput(
      rawCampaign({
        minInfluencerTier: null,
        targetState: null,
        targetDistrict: null,
        languages: [],
      }),
    );
    const view = buildHostEligibilityView(loose, [
      evaluateEligibility(
        loose,
        normalizeCreatorMatchInput(rawCreator("a"), "Influencer"),
      ),
    ]);
    expect(view.configured).toEqual([
      "Creator type",
      "Platform / content",
      "Category",
    ]);
  });

  it("photographer-recipient campaigns are not supported (nothing shown)", () => {
    const photo = normalizeCampaignMatchInput(
      rawCampaign({ inviteRecipientRole: "photographer" }),
    );
    expect(buildHostEligibilityView(photo, [evaluate("a")])).toEqual({
      campaignId: "camp-1",
      supported: false,
      configured: [],
      creators: {},
    });
  });
});

describe("Stage 3B-4 forHost access", () => {
  const setup = (owner: boolean, recipient = "influencer") => {
    const inputs = {
      forCampaignWithTitle: jest.fn().mockResolvedValue({
        input: normalizeCampaignMatchInput(
          rawCampaign({ inviteRecipientRole: recipient }),
        ),
        title: "T",
        ownerId: "brand-1",
      }),
      forAllCreators: jest.fn().mockResolvedValue([
        {
          input: normalizeCreatorMatchInput(rawCreator("a"), "Influencer"),
          display: { name: "", username: "", publicId: "" },
        },
      ]),
    };
    const invites = { isCampaignOwner: jest.fn().mockResolvedValue(owner) };
    return {
      service: new MatchingEligibilityService(inputs as any, invites as any),
      inputs,
      invites,
    };
  };

  it("the campaign owner gets the view", async () => {
    const { service, invites } = setup(true);
    const view = await service.forHost("camp-1", {
      userId: "brand-1",
      role: "brand",
    });
    expect(invites.isCampaignOwner).toHaveBeenCalledWith("brand-1", "brand-1");
    expect(view.creators.a.status).toBe("meets");
  });

  it("other users are refused before any creator is read", async () => {
    const { service, inputs } = setup(false);
    for (const role of ["brand", "influencer", "photographer"]) {
      await expect(
        service.forHost("camp-1", { userId: "someone", role }),
      ).rejects.toThrow(ForbiddenException);
    }
    expect(inputs.forAllCreators).not.toHaveBeenCalled();
  });

  it("admins and subadmins may view any campaign", async () => {
    for (const role of ["admin", "subadmin"]) {
      const { service, invites } = setup(false);
      await expect(
        service.forHost("camp-1", { userId: "x", role }),
      ).resolves.toMatchObject({ supported: true });
      expect(invites.isCampaignOwner).not.toHaveBeenCalled();
    }
  });

  it("photographer-recipient campaigns skip the creator read", async () => {
    const { service, inputs } = setup(true, "photographer");
    await expect(
      service.forHost("camp-1", { userId: "brand-1", role: "brand" }),
    ).resolves.toMatchObject({ supported: false });
    expect(inputs.forAllCreators).not.toHaveBeenCalled();
  });

  it("is GET campaigns/:id/creator-eligibility behind JwtAuthGuard and passes the requester", async () => {
    expect(Reflect.getMetadata("path", HostCampaignEligibilityController)).toBe(
      "campaigns",
    );
    expect(
      Reflect.getMetadata("__guards__", HostCampaignEligibilityController),
    ).toEqual([JwtAuthGuard]);
    const handler = Object.getOwnPropertyDescriptor(
      HostCampaignEligibilityController.prototype,
      "creatorEligibility",
    )?.value;
    expect(Reflect.getMetadata("path", handler)).toBe(
      ":id/creator-eligibility",
    );
    const service = { forHost: jest.fn().mockResolvedValue("ok") };
    await new HostCampaignEligibilityController(
      service as any,
    ).creatorEligibility("camp-1", {
      user: { userId: "brand-1", role: "brand" },
    });
    expect(service.forHost).toHaveBeenCalledWith("camp-1", {
      userId: "brand-1",
      role: "brand",
    });
  });
});
