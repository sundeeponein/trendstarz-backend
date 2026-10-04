import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import {
  EligibilityInvitesService,
  MAX_INVITES_PER_REQUEST,
} from "./eligibility-invites.service";
import { MatchingEligibilityController } from "./matching-eligibility.controller";

const A = "64b0000000000000000000a1";
const B = "64b0000000000000000000b1";
const C = "64b0000000000000000000c1";
const D = "64b0000000000000000000d1";

const rawCreator = (over: Record<string, any> = {}) => ({
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

function setup(
  opts: {
    campaign?: Record<string, any>;
    creators?: Record<string, Record<string, any> | null>;
    alreadyInvited?: string[];
    createImpl?: (ownerId: string, data: any) => Promise<any>;
  } = {},
) {
  const creators = opts.creators ?? {};
  const inputs = {
    forCampaignWithTitle: jest.fn().mockResolvedValue({
      input: normalizeCampaignMatchInput(rawCampaign(opts.campaign)),
      title: "Diwali Reels",
      ownerId: "brand-1",
    }),
    forCreator: jest.fn((type: string, id: string) => {
      const raw = id in creators ? creators[id] : {};
      if (raw === null)
        return Promise.reject(new NotFoundException("Creator not found"));
      return Promise.resolve(
        normalizeCreatorMatchInput(
          { _id: id, ...rawCreator(raw) },
          type as any,
        ),
      );
    }),
  };
  const invites = {
    invitedRecipientIds: jest
      .fn()
      .mockResolvedValue(new Set(opts.alreadyInvited ?? [])),
    create: jest.fn(
      opts.createImpl ??
        ((_owner: string, data: any) =>
          Promise.resolve({ _id: `inv-${data.influencerId}` })),
    ),
  };
  const service = new EligibilityInvitesService(inputs as any, invites as any);
  return { service, inputs, invites };
}

describe("Stage 3B-4 EligibilityInvitesService", () => {
  it("invites PASS creators through the existing invite flow as the campaign owner", async () => {
    const { service, invites } = setup();
    const out = await service.invite("camp-1", [A, B], "admin-1");
    expect(out).toEqual({
      requested: 2,
      invited: [
        { creatorId: A, inviteId: `inv-${A}` },
        { creatorId: B, inviteId: `inv-${B}` },
      ],
      skipped: [],
    });
    expect(invites.create).toHaveBeenCalledWith(
      "brand-1",
      { campaignId: "camp-1", influencerId: A, recipientRole: "influencer" },
      { invitedByAdminId: "admin-1" },
    );
  });

  it("re-evaluates on the server: non-PASS creators are skipped with the blocking reason", async () => {
    const { service, invites } = setup({
      creators: { [B]: { languages: ["Hindi"] }, [C]: { languages: [] } },
    });
    const out = await service.invite("camp-1", [A, B, C], "admin-1");
    expect(out.invited.map((i) => i.creatorId)).toEqual([A]);
    expect(out.skipped).toEqual([
      {
        creatorId: B,
        reason: expect.stringMatching(/^Not eligible: .*language/i),
      },
      { creatorId: C, reason: expect.stringMatching(/^Not eligible: /) },
    ]);
    expect(invites.create).toHaveBeenCalledTimes(1);
  });

  it("skips creators already invited, invalid ids and missing creators", async () => {
    const { service, invites } = setup({
      alreadyInvited: [A],
      creators: { [D]: null },
    });
    const out = await service.invite("camp-1", [A, "nope", D, B, B], "admin-1");
    expect(out.requested).toBe(4);
    expect(out.invited.map((i) => i.creatorId)).toEqual([B]);
    expect(out.skipped).toEqual([
      { creatorId: A, reason: "Already invited to this campaign." },
      { creatorId: "nope", reason: "Invalid creator id." },
      { creatorId: D, reason: "Creator not found" },
    ]);
    expect(invites.invitedRecipientIds).toHaveBeenCalledWith("camp-1", [
      A,
      "nope",
      D,
      B,
    ]);
  });

  it("existing invite-flow refusals (plan limits etc.) come back as skipped, and later creators still run", async () => {
    const { service, invites } = setup({
      createImpl: (_o, data) =>
        data.influencerId === A
          ? Promise.reject(
              new BadRequestException(
                "Plan limit: Only 1 invites per campaign allowed. Upgrade for more.",
              ),
            )
          : Promise.resolve({ _id: "inv-b" }),
    });
    const out = await service.invite("camp-1", [A, B], "admin-1");
    expect(out.skipped).toEqual([
      {
        creatorId: A,
        reason:
          "Plan limit: Only 1 invites per campaign allowed. Upgrade for more.",
      },
    ]);
    expect(out.invited).toEqual([{ creatorId: B, inviteId: "inv-b" }]);
    expect(invites.create).toHaveBeenCalledTimes(2);
  });

  it("invites sequentially (plan-limit counts must see earlier invites)", async () => {
    let running = 0;
    let maxRunning = 0;
    const { service } = setup({
      createImpl: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { _id: "x" };
      },
    });
    await service.invite("camp-1", [A, B, C], "admin-1");
    expect(maxRunning).toBe(1);
  });

  it("photographer-recipient campaigns invite photographers", async () => {
    const { service, inputs, invites } = setup({
      campaign: { inviteRecipientRole: "photographer" },
    });
    await service.invite("camp-1", [A], "admin-1");
    expect(inputs.forCreator).toHaveBeenCalledWith("Photographer", A);
    // Photographer campaigns are UNKNOWN in 3B-2, so nothing is sent.
    expect(invites.create).not.toHaveBeenCalled();
  });

  it("refuses non-live campaigns, empty/oversized selections and a missing admin", async () => {
    for (const status of ["draft", "pending_review", "completed"]) {
      const { service, invites } = setup({ campaign: { status } });
      await expect(service.invite("camp-1", [A], "admin-1")).rejects.toThrow(
        "Invites can only be sent for live (approved) campaigns.",
      );
      expect(invites.create).not.toHaveBeenCalled();
    }
    const { service } = setup();
    await expect(service.invite("camp-1", [], "admin-1")).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.invite("camp-1", "not-an-array", "admin-1"),
    ).rejects.toThrow(BadRequestException);
    const tooMany = Array.from(
      { length: MAX_INVITES_PER_REQUEST + 1 },
      (_, i) => `64b00000000000000000${String(i).padStart(4, "0")}`,
    );
    await expect(service.invite("camp-1", tooMany, "admin-1")).rejects.toThrow(
      `At most ${MAX_INVITES_PER_REQUEST} creators per request.`,
    );
    await expect(service.invite("camp-1", [A], "")).rejects.toThrow(
      "Admin not identified.",
    );
  });

  it("is POST admin/matching/eligibility/:campaignId/invites and passes the admin id", async () => {
    const handler = Object.getOwnPropertyDescriptor(
      MatchingEligibilityController.prototype,
      "inviteEligible",
    )?.value;
    expect(Reflect.getMetadata("path", handler)).toBe(
      "eligibility/:campaignId/invites",
    );
    expect(Reflect.getMetadata("method", handler)).toBe(1); // RequestMethod.POST
    const invitesService = { invite: jest.fn().mockResolvedValue("ok") };
    const controller = new MatchingEligibilityController(
      {} as any,
      invitesService as any,
    );
    await controller.inviteEligible(
      "camp-1",
      { creatorIds: [A] },
      { user: { userId: "admin-1", role: "admin" } },
    );
    expect(invitesService.invite).toHaveBeenCalledWith(
      "camp-1",
      [A],
      "admin-1",
    );
  });
});
