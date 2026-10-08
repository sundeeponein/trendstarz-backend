import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
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
const E = "64b0000000000000000000e1";
const F = "64b0000000000000000000f1";

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

/**
 * creators: id → raw overrides (default: an eligible creator); null = not in
 * the database. invitedAtStart / invitedLater simulate invites that exist when
 * the batch check runs vs. appear just before create() (race with the host).
 */
function setup(
  opts: {
    campaign?: Record<string, any>;
    creators?: Record<string, Record<string, any> | null>;
    invitedAtStart?: string[];
    invitedLater?: string[];
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
    forCreatorsByIds: jest.fn((type: string, ids: string[]) =>
      Promise.resolve(
        new Map(
          ids
            .filter((id) => creators[id] !== null)
            .map((id) => [
              id,
              normalizeCreatorMatchInput(
                { _id: id, ...rawCreator(creators[id] ?? {}) },
                type as any,
              ),
            ]),
        ),
      ),
    ),
    forCreator: jest.fn(),
  };
  let batchChecked = false;
  const invites = {
    invitedRecipientIds: jest.fn((_c: string, ids: string[]) => {
      const pool = batchChecked
        ? [...(opts.invitedAtStart ?? []), ...(opts.invitedLater ?? [])]
        : (opts.invitedAtStart ?? []);
      batchChecked = true;
      return Promise.resolve(new Set(ids.filter((id) => pool.includes(id))));
    }),
    create: jest.fn(
      opts.createImpl ??
        ((_owner: string, data: any) =>
          Promise.resolve({ _id: `inv-${data.influencerId}` })),
    ),
  };
  const service = new EligibilityInvitesService(inputs as any, invites as any);
  return { service, inputs, invites };
}

describe("Stage 3B-3/4 admin invites — send-time validation", () => {
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

  it("loads the whole selection in one creator read (no per-creator profile/evidence queries)", async () => {
    const { service, inputs } = setup();
    await service.invite("camp-1", [A, B, C], "admin-1");
    expect(inputs.forCreatorsByIds).toHaveBeenCalledTimes(1);
    expect(inputs.forCreatorsByIds).toHaveBeenCalledWith("Influencer", [
      A,
      B,
      C,
    ]);
    expect(inputs.forCreator).not.toHaveBeenCalled();
  });

  it("per-creator results: invited / already invited / no longer eligible / unknown / unavailable", async () => {
    const { service, invites } = setup({
      invitedAtStart: [B],
      creators: {
        [C]: { languages: ["Hindi"] }, // became ineligible after selection
        [D]: { languages: [] }, // language can't be checked → UNKNOWN
        [E]: null, // removed from the database
        [F]: { isDeleted: true }, // soft-deleted
      },
    });
    const out = await service.invite(
      "camp-1",
      [A, B, C, D, E, F, "nope"],
      "admin-1",
    );
    expect(out.invited.map((i) => i.creatorId)).toEqual([A]);
    expect(out.skipped.map((s) => [s.creatorId, s.code])).toEqual([
      [B, "already_invited"],
      [C, "not_eligible"],
      [D, "eligibility_unknown"],
      [E, "unavailable"],
      [F, "unavailable"],
      ["nope", "invalid_id"],
    ]);
    expect(out.skipped[1].reason).toMatch(/^No longer eligible: .*language/i);
    expect(out.skipped[2].reason).toMatch(/^Eligibility unknown: /);
    // UNKNOWN is never treated as eligible; only A reached the invite flow.
    expect(invites.create).toHaveBeenCalledTimes(1);
  });

  it("race: an invite created by someone else after the batch check is caught before create()", async () => {
    const { service, invites } = setup({ invitedLater: [B] });
    const out = await service.invite("camp-1", [A, B], "admin-1");
    expect(out.invited.map((i) => i.creatorId)).toEqual([A]);
    expect(out.skipped).toEqual([
      {
        creatorId: B,
        code: "already_invited",
        reason: "Already invited to this campaign.",
      },
    ]);
    expect(invites.create).toHaveBeenCalledTimes(1);
  });

  it("existing invite-flow refusals (plan limits etc.) are per-creator; later creators still run", async () => {
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
        code: "invite_rejected",
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

  it("campaign no longer accepting invites → whole request refused, nothing read or sent", async () => {
    const cases: Array<[Record<string, any>, string]> = [
      [{ status: "draft" }, "live (approved) campaigns"],
      [{ status: "pending_review" }, "live (approved) campaigns"],
      [{ status: "completed" }, "live (approved) campaigns"],
      [
        { acceptanceDeadline: new Date(Date.now() - 60_000) },
        "closed by deadline",
      ],
    ];
    for (const [campaign, message] of cases) {
      const { service, invites, inputs } = setup({ campaign });
      await expect(service.invite("camp-1", [A], "admin-1")).rejects.toThrow(
        message,
      );
      expect(invites.create).not.toHaveBeenCalled();
      expect(inputs.forCreatorsByIds).not.toHaveBeenCalled();
    }
  });

  it("photographer-recipient campaigns: UNKNOWN in 3B-2, so nothing is sent", async () => {
    const { service, inputs, invites } = setup({
      campaign: { inviteRecipientRole: "photographer" },
    });
    const out = await service.invite("camp-1", [A], "admin-1");
    expect(inputs.forCreatorsByIds).toHaveBeenCalledWith("Photographer", [A]);
    expect(out.skipped[0].code).toBe("eligibility_unknown");
    expect(invites.create).not.toHaveBeenCalled();
  });

  it("refuses empty/oversized selections and a missing admin", async () => {
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
});

describe("Stage 3B-3/4 admin invites — API protection", () => {
  const handler = Object.getOwnPropertyDescriptor(
    MatchingEligibilityController.prototype,
    "inviteEligible",
  )?.value;

  it("is POST admin/matching/eligibility/:campaignId/invites behind JwtAuthGuard + RolesGuard", () => {
    expect(Reflect.getMetadata("path", MatchingEligibilityController)).toBe(
      "admin/matching",
    );
    expect(Reflect.getMetadata("path", handler)).toBe(
      "eligibility/:campaignId/invites",
    );
    expect(Reflect.getMetadata("method", handler)).toBe(1); // RequestMethod.POST
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

  it("unauthenticated, creators and brands/hosts are refused; admin and subadmin allowed", async () => {
    const roles = new RolesGuard();
    expect(roles.canActivate(ctx({ role: "admin" }))).toBe(true);
    expect(roles.canActivate(ctx({ role: "subadmin" }))).toBe(true);
    for (const role of ["influencer", "photographer", "brand"])
      expect(() => roles.canActivate(ctx({ role }))).toThrow(
        ForbiddenException,
      );
    const jwtGuard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as any,
      { models: {} } as any,
    );
    await expect(jwtGuard.canActivate(ctx(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("only creatorIds reach the service — crafted eligibility/owner fields are ignored", async () => {
    const invitesService = { invite: jest.fn().mockResolvedValue("ok") };
    const controller = new MatchingEligibilityController(
      {} as any,
      invitesService as any,
    );
    await controller.inviteEligible(
      "camp-1",
      {
        creatorIds: [A],
        overall: "PASS",
        eligibility: { [A]: "PASS" },
        ownerId: "attacker",
        invitedByAdminId: "someone-else",
      } as any,
      { user: { userId: "admin-1", role: "admin" } },
    );
    expect(invitesService.invite).toHaveBeenCalledWith(
      "camp-1",
      [A],
      "admin-1",
    );
  });

  it("an ineligible creator is re-evaluated on the server and skipped, whatever the browser believed", async () => {
    const { service, invites } = setup({
      creators: { [A]: { categories: ["Food"] } },
    });
    const out = await service.invite("camp-1", [A], "admin-1");
    expect(out.skipped[0]).toMatchObject({
      creatorId: A,
      code: "not_eligible",
    });
    expect(invites.create).not.toHaveBeenCalled();
  });
});
