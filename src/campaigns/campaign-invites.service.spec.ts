jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlansService } from "../plans/plans.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PlatformEventsService } from "../platform-events/platform-events.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";
import { TrackingLinksService } from "./tracking-links.service";
import { sendAppEmail } from "../utils/app-email.service";

/** Mongoose query stand-in: chainable, awaitable, resolves to `value`. */
function queryOf(value: any = null) {
  const q: any = {};
  ["select", "lean", "sort", "limit", "skip", "populate", "exec"].forEach((m) => (q[m] = jest.fn(() => q)));
  q.then = (res: any, rej: any) => Promise.resolve(value).then(res, rej);
  return q;
}

/**
 * Wraps a test's model fake so methods it doesn't define still behave like an
 * empty collection (find → [], findOne/findById → null, counts → 0). Methods
 * the test does define — and any return values it sets later — are untouched.
 */
function lenientModel(fake: any): any {
  const defaults: Record<string, () => any> = {
    find: () => queryOf([]),
    findOne: () => queryOf(null),
    findById: () => queryOf(null),
    findOneAndUpdate: () => queryOf(null),
    findByIdAndUpdate: () => queryOf(null),
    countDocuments: () => queryOf(0),
    distinct: () => queryOf([]),
    aggregate: () => queryOf([]),
    updateOne: () => queryOf({ acknowledged: true, modifiedCount: 0 }),
    updateMany: () => queryOf({ acknowledged: true, modifiedCount: 0 }),
    exists: () => queryOf(null),
  };
  return new Proxy(fake, {
    get: (target, prop, receiver) => {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && defaults[prop]) {
        const fn = jest.fn(defaults[prop]);
        (target as any)[prop] = fn;
        return fn;
      }
      return undefined;
    },
  });
}

/** Any method resolves to undefined. Skips `then` (and symbols) so Nest doesn't treat it as a promise. */
function inertService(): any {
  return new Proxy({}, {
    get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn().mockResolvedValue(undefined)),
  });
}

/** Collaborators added to CampaignInvitesService after these tests were written; defaults are inert. */
const laterInviteProviders = [
  {
    provide: getModelToken("AppSettings"),
    useValue: {
      findOne: jest.fn(() => queryOf(null)),
      find: jest.fn(() => queryOf([])),
      findById: jest.fn(() => queryOf(null)),
    },
  },
  { provide: WhatsAppService, useValue: inertService() },
  { provide: ProfileVerificationService, useValue: inertService() },
  { provide: TrackingLinksService, useValue: inertService() },
  { provide: PlatformEventsService, useValue: inertService() },
];

describe("CampaignInvitesService (admin disputes + remind)", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let brandModel: any;
  let photographerModel: any;
  let influencerModel: any;
  let campaignModel: any;

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.findById = jest.fn();
    inviteModel.countDocuments = jest.fn();
    inviteModel.find = jest.fn();

    brandModel = jest.fn();
    brandModel.findById = jest.fn();
    brandModel.find = jest.fn();

    photographerModel = jest.fn();
    photographerModel.findById = jest.fn();
    photographerModel.find = jest.fn();

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn();
    influencerModel.find = jest.fn();

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn();
    campaignModel.find = jest.fn();

    const submissionModel: any = {};
    const txnModel: any = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        {
          provide: getModelToken("CampaignSubmission"),
          useValue: lenientModel(submissionModel),
        },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: lenientModel(brandModel) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(photographerModel) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(influencerModel) },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: lenientModel(txnModel),
        },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
    (sendAppEmail as jest.Mock).mockClear();
  });

  describe("adminCountOpenDisputes", () => {
    it("counts disputed invites with unresolved reportedIssue", async () => {
      inviteModel.countDocuments.mockResolvedValue(7);
      const result = await service.adminCountOpenDisputes();
      // Open = an issue was reported and not yet resolved (any invite status).
      expect(inviteModel.countDocuments).toHaveBeenCalledWith({
        "reportedIssue.reportedAt": { $ne: null },
        "reportedIssue.resolvedAt": { $in: [null, undefined] },
      });
      expect(result).toEqual({ count: 7 });
    });
  });

  describe("adminResolveDispute", () => {
    it("throws NotFound when invite missing", async () => {
      inviteModel.findById.mockResolvedValue(null);
      await expect(service.adminResolveDispute("x")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequest when invite has no reportedIssue", async () => {
      inviteModel.findById.mockResolvedValue({
        reportedIssue: undefined,
      });
      await expect(service.adminResolveDispute("x")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("sets resolvedAt and flips status when outcome supplied", async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const invite: any = {
        _id: "i1",
        status: "disputed",
        reportedIssue: { reportedAt: new Date(), reason: "broken" },
        save,
      };
      inviteModel.findById.mockResolvedValue(invite);

      const result = await service.adminResolveDispute("i1", {
        outcome: "completed",
        note: "reviewed",
      });

      expect(invite.reportedIssue.resolvedAt).toBeInstanceOf(Date);
      expect(invite.reportedIssue.reason).toContain("broken");
      expect(invite.reportedIssue.reason).toContain("[admin");
      expect(invite.reportedIssue.reason).toContain("reviewed");
      expect(invite.status).toBe("completed");
      expect(save).toHaveBeenCalled();
      expect(result).toEqual({ success: true, status: "completed" });
    });

    it("sets withdrawnAt when outcome=withdrawn", async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const invite: any = {
        status: "disputed",
        reportedIssue: { reportedAt: new Date() },
        save,
      };
      inviteModel.findById.mockResolvedValue(invite);
      await service.adminResolveDispute("i", { outcome: "withdrawn" });
      expect(invite.withdrawnAt).toBeInstanceOf(Date);
      expect(invite.status).toBe("withdrawn");
    });
  });

  describe("adminListDisputes", () => {
    it("falls back to photographer owner when brand lookup is empty", async () => {
      inviteModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              {
                _id: "inv1",
                campaignId: "camp1",
                brandId: "photo1",
                influencerId: "inf1",
                status: "disputed",
                reportedIssue: { reportedAt: new Date(), resolvedAt: null },
              },
            ]),
          }),
        }),
      });

      campaignModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "camp1",
              title: "Studio Test",
              campaignType: "creative_project",
              ownerType: "photographer",
            },
          ]),
        }),
      });

      brandModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      });

      photographerModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { _id: "photo1", name: "Lens Master", email: "photo@test.com" },
          ]),
        }),
      });

      influencerModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { _id: "inf1", name: "Creator A", email: "inf@test.com" },
          ]),
        }),
      });

      const result = await service.adminListDisputes();

      expect(result.invites).toHaveLength(1);
      expect(result.invites[0].brand).toEqual(
        expect.objectContaining({ name: "Lens Master", email: "photo@test.com" }),
      );
      expect(result.invites[0].campaign).toEqual(
        expect.objectContaining({ ownerType: "photographer" }),
      );
    });
  });

  describe("remindInvite throttle", () => {
    function brandOwnedInvite(overrides: any = {}) {
      const save = jest.fn().mockResolvedValue(undefined);
      return {
        _id: "inv1",
        brandId: "brand1",
        influencerId: "inf1",
        campaignId: "camp1",
        status: "pending",
        save,
        ...overrides,
      };
    }

    function mockChainSelectLean(value: any) {
      return {
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(value),
        }),
      };
    }

    beforeEach(() => {
      // brand ownership lookup fallback used inside assertBrandOwnsInvite
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ brandUsername: "brand1", isEmailVerified: true, isMobileVerified: true }),
      );
      influencerModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            email: "inf@example.com",
            name: "Inf",
          }),
        }),
      });
      campaignModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ title: "Campaign X" }),
        }),
      });
    });

    it("sends a reminder and email on first call", async () => {
      const invite = brandOwnedInvite();
      inviteModel.findById.mockResolvedValue(invite);
      // brand lookup for email enrichment
      brandModel.findById
        .mockReturnValueOnce(mockChainSelectLean({ brandUsername: "brand1", isEmailVerified: true, isMobileVerified: true })) // assertBrandOwnsInvite no-op (skipped because brandId matches)
        .mockReturnValueOnce(mockChainSelectLean({ name: "Brand X" })); // email enrichment
      const res = await service.remindInvite("inv1", "brand1");
      expect(invite.remindersSent).toBe(1);
      expect(invite.remindedAt).toBeInstanceOf(Date);
      expect(invite.save).toHaveBeenCalled();
      expect(sendAppEmail).toHaveBeenCalledTimes(1);
      const call = (sendAppEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe("inf@example.com");
      expect(call.html).toContain("Campaign X");
      expect(res.success).toBe(true);
    });

    it("rejects a second reminder within 24h", async () => {
      const invite = brandOwnedInvite({
        remindedAt: new Date(),
        remindersSent: 1,
      });
      inviteModel.findById.mockResolvedValue(invite);
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ name: "Brand X" }),
      );
      await expect(service.remindInvite("inv1", "brand1")).rejects.toThrow(
        BadRequestException,
      );
      expect(sendAppEmail).not.toHaveBeenCalled();
    });

    it("allows a reminder after 24h", async () => {
      const invite = brandOwnedInvite({
        remindedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        remindersSent: 1,
      });
      inviteModel.findById.mockResolvedValue(invite);
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ name: "Brand X" }),
      );
      const res = await service.remindInvite("inv1", "brand1");
      expect(res.success).toBe(true);
      expect(invite.remindersSent).toBe(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: create() – invite gating (deadline, threshold, maxInfluencers)
// ─────────────────────────────────────────────────────────────────────────────
jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));

describe("CampaignInvitesService – create() gating", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let brandModel: any;
  let influencerModel: any;
  let campaignModel: any;
  let plansService: any;

  beforeEach(async () => {
    inviteModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({ ...data, _id: "inv-new" }),
    }));
    inviteModel.findById = jest.fn();
    inviteModel.countDocuments = jest.fn().mockResolvedValue(0);
    inviteModel.find = jest.fn();
    inviteModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });

    brandModel = jest.fn();
    brandModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ brandUsername: "brand1", isEmailVerified: true, isMobileVerified: true }),
      }),
    });

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ email: "inf@test.com", name: "Inf", isEmailVerified: true, isMobileVerified: true }),
      }),
    });

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn();

    plansService = {
      getUserPlanCapabilities: jest.fn().mockResolvedValue({
        hasPremium: false,
        features: [{ key: "canInviteUsers", value: true }],
        limits: [{ key: "maxInvitesPerCampaign", value: -1 }],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel({}) },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: lenientModel(brandModel) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(influencerModel) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel({}) },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  function mockCampaignLean(overrides: any = {}) {
    const data = {
      _id: "camp1",
      brandId: "brand1",
      title: "Test Campaign",
      // Real campaigns always have a status (schema default "draft"); invites
      // need a live or in-review one.
      status: "active",
      ...overrides,
    };
    // create() calls campaignModel.findById(id).lean()
    campaignModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(data),
    });
  }

  it.each(["draft", "rejected", "completed", "cancelled", ""])(
    "refuses invites for a brand campaign that is %s (not live or in review)",
    async (status) => {
      mockCampaignLean({ status, ownerType: "brand" });
      await expect(
        service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
      ).rejects.toThrow(
        "Invites can only be sent for active or pending-review campaigns.",
      );
    },
  );

  it.each(["active", "pending", "pending_review", "needs_changes"])(
    "accepts invites for a brand campaign that is %s",
    async (status) => {
      mockCampaignLean({ status, ownerType: "brand" });
      inviteModel.countDocuments.mockResolvedValue(0);
      await expect(
        service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
      ).resolves.toBeDefined();
    },
  );

  it("collaborations keep their own wording", async () => {
    mockCampaignLean({ status: "completed", ownerType: "photographer" });
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(
      "Invites can only be sent for active or pending-review collaborations.",
    );
  });

  it("throws BadRequest when acceptanceDeadline has passed", async () => {
    mockCampaignLean({ acceptanceDeadline: new Date(Date.now() - 60_000) });
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows invite when acceptanceDeadline is in the future", async () => {
    mockCampaignLean({ acceptanceDeadline: new Date(Date.now() + 60 * 60 * 1000) });
    inviteModel.countDocuments.mockResolvedValue(0);
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).resolves.toBeDefined();
  });

  it("throws when acceptedCount >= maxInfluencers (threshold reached)", async () => {
    mockCampaignLean({ maxInfluencers: 3 });
    inviteModel.countDocuments
      .mockResolvedValueOnce(0) // inviteCount for maxInfluencers check
      .mockResolvedValueOnce(3); // acceptedCount for threshold
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("does NOT close when disputed invites inflate count (slot re-opens)", async () => {
    // maxInfluencers = 2, only 1 non-disputed accepted — must NOT close
    mockCampaignLean({ maxInfluencers: 2 });
    inviteModel.countDocuments
      .mockResolvedValueOnce(0) // inviteCount for maxInfluencers check
      .mockResolvedValueOnce(1); // acceptedCount (disputed excluded by query)
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).resolves.toBeDefined();
  });

  it("allows extra invites until the plan cap even when maxInfluencers is the accepted close target", async () => {
    mockCampaignLean({ maxInfluencers: 2 });
    inviteModel.countDocuments
      .mockResolvedValueOnce(2) // already invited; no longer capped by maxInfluencers
      .mockResolvedValueOnce(1); // acceptedCount remains below close target
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).resolves.toBeDefined();
  });

  it("monthly owner cap: says invites per month (it counts invites, not campaigns)", async () => {
    mockCampaignLean({});
    const ownerCaps = {
      features: [{ key: "canInviteUsers", value: true }],
      limits: [
        { key: "maxInvitesPerCampaign", value: -1 },
        { key: "maxInvitesPerMonth", value: 5 },
      ],
    };
    plansService.getUserPlanCapabilities.mockImplementation((userId: string) =>
      Promise.resolve(userId === "inf1" ? { limits: [] } : ownerCaps),
    );
    inviteModel.countDocuments.mockImplementation((query: any) =>
      Promise.resolve(query?.brandId === "brand1" && query?.createdAt ? 5 : 0),
    );
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(
      "Plan limit: Only 5 invites per month allowed. Upgrade for more.",
    );
  });

  it("recipient cap uses the creator plan's receive limit, not its per-campaign value", async () => {
    mockCampaignLean({});
    plansService.getUserPlanCapabilities.mockImplementation((userId: string) =>
      Promise.resolve(
        userId === "inf1"
          ? {
              limits: [
                { key: "maxInvitesPerCampaign", value: 1 },
                { key: "maxInvitesReceivedPerMonth", value: 2 },
              ],
            }
          : {
              features: [{ key: "canInviteUsers", value: true }],
              limits: [{ key: "maxInvitesPerCampaign", value: -1 }],
            },
      ),
    );
    // Already holds 1 invite this month: allowed (limit 2); at 2 it is refused.
    let held = 1;
    inviteModel.countDocuments.mockImplementation((query: any) =>
      Promise.resolve(query?.influencerId === "inf1" ? held : 0),
    );
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).resolves.toBeDefined();
    held = 2;
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow("has reached their monthly invite limit (2)");
  });

  it("enforces recipient cap based on accepted + active pending only", async () => {
    mockCampaignLean({ acceptanceDeadline: new Date(Date.now() + 60 * 60 * 1000) });
    plansService.getUserPlanCapabilities.mockImplementation(async (userId: string) => {
      if (userId === "inf1") {
        return { limits: [{ key: "maxInvitesPerCampaign", value: 1 }] };
      }
      return {
        hasPremium: false,
        features: [{ key: "canInviteUsers", value: true }],
        limits: [{ key: "maxInvitesPerCampaign", value: -1 }],
      };
    });

    inviteModel.countDocuments.mockImplementation(async (query: any) => {
      if (query?.influencerId === "inf1") return 1;
      return 0;
    });

    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(BadRequestException);

    const recipientQuery = inviteModel.countDocuments.mock.calls
      .map((call: any[]) => call[0])
      .find((q: any) => q?.influencerId === "inf1");

    expect(recipientQuery).toBeDefined();
    const serialized = JSON.stringify(recipientQuery);
    expect(serialized).toContain("accepted");
    expect(serialized).toContain("pending");
    expect(serialized).toContain("overdueFlaggedAt");
    expect(serialized).toContain("dueDate");
    expect(serialized).not.toContain("declined");
    expect(serialized).not.toContain("withdrawn");
  });

  it("defaults invite dueDate to campaign acceptanceDeadline", async () => {
    const acceptanceDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    mockCampaignLean({ acceptanceDeadline });

    inviteModel.countDocuments.mockResolvedValue(0);

    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).resolves.toBeDefined();

    expect(inviteModel).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: acceptanceDeadline }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: respond() – acceptanceDeadline, threshold, insightsUnlocksAt
// ─────────────────────────────────────────────────────────────────────────────
describe("CampaignInvitesService – respond()", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let brandModel: any;
  let influencerModel: any;
  let campaignModel: any;
  let plansService: any;

  const CAMPAIGN_START = new Date("2026-06-01");
  const CAMPAIGN_END = new Date("2026-08-31");

  function mockCampaignSelect(overrides: any = {}) {
    const data = {
      // Recipients may only act on live (admin-approved) campaigns.
      status: "active",
      startDate: CAMPAIGN_START,
      endDate: CAMPAIGN_END,
      timelineStart: CAMPAIGN_START,
      timelineEnd: CAMPAIGN_END,
      pricePerInfluencer: 500000,
      socialMedia: [],
      minInfluencers: 0,
      maxInfluencers: 0,
      ...overrides,
    };
    return {
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(data) }),
    };
  }

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.findById = jest.fn();
    inviteModel.countDocuments = jest.fn().mockResolvedValue(0);
    inviteModel.find = jest.fn();
    inviteModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });

    brandModel = jest.fn();
    brandModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ email: "brand@test.com", brandName: "Brand" }),
      }),
    });

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ name: "Inf" }),
      }),
    });
    influencerModel.findByIdAndUpdate = jest.fn().mockResolvedValue(undefined);

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn();

    plansService = { getUserPlanCapabilities: jest.fn().mockResolvedValue({ limits: [] }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel({}) },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: lenientModel(brandModel) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(influencerModel) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel({}) },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  function pendingInvite(overrides: any = {}) {
    const save = jest.fn().mockImplementation(function (this: any) {
      return Promise.resolve(this);
    });
    return {
      _id: "inv1",
      influencerId: "inf1",
      brandId: "brand1",
      campaignId: "camp1",
      status: "pending",
      save,
      ...overrides,
    };
  }

  it("throws when invite not found", async () => {
    inviteModel.findById.mockResolvedValue(null);
    await expect(service.respond("x", "inf1", "accepted", "2026-07-01")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("throws when influencer does not own the invite", async () => {
    inviteModel.findById.mockResolvedValue(pendingInvite({ influencerId: "other" }));
    await expect(service.respond("inv1", "inf1", "accepted", "2026-07-01")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws when invite is not pending", async () => {
    inviteModel.findById.mockResolvedValue(pendingInvite({ status: "accepted" }));
    await expect(service.respond("inv1", "inf1", "accepted", "2026-07-01")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws when acceptanceDeadline has passed", async () => {
    inviteModel.findById.mockResolvedValue(pendingInvite());
    campaignModel.findById.mockReturnValue(
      mockCampaignSelect({ acceptanceDeadline: new Date(Date.now() - 1000) }),
    );
    await expect(service.respond("inv1", "inf1", "accepted", "2026-07-01")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws when acceptance threshold already reached", async () => {
    inviteModel.findById.mockResolvedValue(pendingInvite());
    campaignModel.findById.mockReturnValue(mockCampaignSelect({ maxInfluencers: 2 }));
    inviteModel.countDocuments.mockResolvedValue(2); // already 2 accepted
    await expect(service.respond("inv1", "inf1", "accepted", "2026-07-01")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("sets insightsUnlocksAt = selectedPostDate + 24h on acceptance", async () => {
    const invite = pendingInvite();
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(mockCampaignSelect());
    inviteModel.countDocuments.mockResolvedValue(0);

    const postDate = "2026-07-15";
    await service.respond("inv1", "inf1", "accepted", postDate);

    const selectedMs = new Date(postDate).getTime();
    const unlockMs = new Date(invite.insightsUnlocksAt).getTime();
    expect(unlockMs - selectedMs).toBe(24 * 60 * 60 * 1000);
  });

  it("sets acceptedAt on acceptance", async () => {
    const invite = pendingInvite();
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(mockCampaignSelect());
    inviteModel.countDocuments.mockResolvedValue(0);

    await service.respond("inv1", "inf1", "accepted", "2026-07-15");
    expect(invite.acceptedAt).toBeInstanceOf(Date);
  });

  it("withdraws remaining pending invites for the role when accepted target is reached", async () => {
    const invite = pendingInvite({ recipientRole: "influencer" });
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(mockCampaignSelect({ maxInfluencers: 1 }));
    inviteModel.countDocuments
      .mockResolvedValueOnce(0) // pre-accept threshold check
      .mockResolvedValueOnce(1); // post-save close check

    await service.respond("inv1", "inf1", "accepted", "2026-07-15");

    expect(inviteModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $ne: "inv1" },
        campaignId: "camp1",
        status: { $in: ["pending", "invited", "counter_sent"] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "withdrawn",
          withdrawnReason: expect.stringContaining("Auto-closed"),
        }),
      }),
    );
  });

  it("does not auto-unlock coordination details for invite_location on acceptance", async () => {
    const invite = pendingInvite();
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(
      mockCampaignSelect({ campaignType: "invite_location" }),
    );
    inviteModel.countDocuments.mockResolvedValue(0);

    await service.respond("inv1", "inf1", "accepted", "2026-07-15");

    expect(invite.unlocked).toBeFalsy();
    expect(invite.unlockType).toBeUndefined();
    expect(invite.unlockedAt).toBeUndefined();
  });

  it("rejects acceptance when selectedPlatform does not match locked invite platform", async () => {
    const invite = pendingInvite({ selectedPlatform: "Instagram" });
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(
      mockCampaignSelect({
        socialMedia: [
          {
            platform: "Instagram",
            contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
          },
          {
            platform: "YouTube",
            contentTypes: [{ name: "Video", enabled: true, price: 10000 }],
          },
        ],
      }),
    );
    inviteModel.countDocuments.mockResolvedValue(0);

    await expect(
      service.respond(
        "inv1",
        "inf1",
        "accepted",
        "2026-07-15",
        "YouTube",
        "Video",
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts using locked invite platform and stores agreedAmount from matching content type", async () => {
    const invite = pendingInvite({ selectedPlatform: "Instagram" });
    inviteModel.findById.mockResolvedValue(invite);
    campaignModel.findById.mockReturnValue(
      mockCampaignSelect({
        socialMedia: [
          {
            platform: "Instagram",
            contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
          },
          {
            platform: "YouTube",
            contentTypes: [{ name: "Video", enabled: true, price: 10000 }],
          },
        ],
      }),
    );
    inviteModel.countDocuments.mockResolvedValue(0);

    await service.respond(
      "inv1",
      "inf1",
      "accepted",
      "2026-07-15",
      "Instagram",
      "Reel",
    );

    expect(invite.selectedPlatform).toBe("Instagram");
    expect(invite.selectedContentType).toBe("Reel");
    expect(invite.agreedAmount).toBe(5000);
  });

  it("throws when selectedPostDate is outside campaign timeline", async () => {
    inviteModel.findById.mockResolvedValue(pendingInvite());
    campaignModel.findById.mockReturnValue(mockCampaignSelect());
    await expect(
      service.respond("inv1", "inf1", "accepted", "2025-01-01"), // before start
    ).rejects.toThrow(BadRequestException);
  });

  it("allows decline without selectedPostDate", async () => {
    const invite = pendingInvite();
    inviteModel.findById.mockResolvedValue(invite);
    await service.respond("inv1", "inf1", "declined");
    expect(invite.status).toBe("declined");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: submitPost() – insights 24h lock enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe("CampaignInvitesService – submitPost() insights lock", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let submissionModel: any;
  let brandModel: any;
  let influencerModel: any;
  let campaignModel: any;
  let campaignTransactionModel: any;

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.findById = jest.fn();

    submissionModel = { findOne: jest.fn(), create: jest.fn() };

    brandModel = jest.fn();
    brandModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn().mockReturnValue({
      // Work can only be submitted on live (admin-approved) campaigns.
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: "camp1", status: "active" }) }),
    });

    campaignTransactionModel = { updateMany: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel(submissionModel) },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: lenientModel(brandModel) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(influencerModel) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel(campaignTransactionModel) },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  function acceptedInvite(overrides: any = {}) {
    const save = jest.fn().mockResolvedValue(undefined);
    return {
      _id: "inv1",
      influencerId: "inf1",
      brandId: "brand1",
      campaignId: "camp1",
      status: "accepted",
      insightsUnlocksAt: null,
      save,
      ...overrides,
    };
  }

  it("throws BadRequest when insights submitted before insightsUnlocksAt", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // still locked
    inviteModel.findById.mockResolvedValue(
      acceptedInvite({ insightsUnlocksAt: future }),
    );
    await expect(
      service.submitPost("inv1", "inf1", {
        postUrl: "https://instagram.com/p/abc",
        likesCount: 100,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows insights submission after insightsUnlocksAt has passed", async () => {
    const past = new Date(Date.now() - 1000); // already unlocked
    const invite = acceptedInvite({ insightsUnlocksAt: past });
    inviteModel.findById.mockResolvedValue(invite);
    submissionModel.findOne.mockResolvedValue(null);
    submissionModel.create.mockResolvedValue({ _id: "sub1" });

    const result = await service.submitPost("inv1", "inf1", {
      postUrl: "https://instagram.com/p/abc",
      likesCount: 100,
    });
    expect(result.success).toBe(true);
  });

  it("allows postUrl submission without insights when still locked", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const invite = acceptedInvite({ insightsUnlocksAt: future });
    inviteModel.findById.mockResolvedValue(invite);
    submissionModel.findOne.mockResolvedValue(null);
    submissionModel.create.mockResolvedValue({ _id: "sub1" });

    // No insights fields — should succeed
    const result = await service.submitPost("inv1", "inf1", {
      postUrl: "https://instagram.com/p/abc",
    });
    expect(result.success).toBe(true);
  });

  it("throws NotFoundException when invite does not exist", async () => {
    inviteModel.findById.mockResolvedValue(null);
    await expect(
      service.submitPost("bad-id", "inf1", { postUrl: "https://instagram.com/p/abc" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequest when invite belongs to another influencer", async () => {
    inviteModel.findById.mockResolvedValue(
      acceptedInvite({ influencerId: "other-inf" }),
    );
    await expect(
      service.submitPost("inv1", "inf1", { postUrl: "https://instagram.com/p/abc" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws when postUrl is missing", async () => {
    inviteModel.findById.mockResolvedValue(acceptedInvite());
    await expect(
      service.submitPost("inv1", "inf1", { postUrl: "" }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: applyToCampaign() – invite-only enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe("CampaignInvitesService – applyToCampaign()", () => {
  let service: CampaignInvitesService;
  let campaignModel: any;

  beforeEach(async () => {
    const inviteModel: any = jest.fn();
    inviteModel.findById = jest.fn();
    inviteModel.countDocuments = jest.fn();
    inviteModel.find = jest.fn();

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "camp1",
        status: "active",
        campaignMode: "invite_only",
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel({}) },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel({}) },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  it("always throws BadRequest (invite-only mode is active)", async () => {
    await expect(service.applyToCampaign("inf1", "camp1")).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("CampaignInvitesService contact visibility in invite lists", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let photographerModel: any;

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.find = jest.fn();

    photographerModel = jest.fn();
    photographerModel.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel({}) },
        { provide: getModelToken("Campaign"), useValue: lenientModel({}) },
        { provide: getModelToken("Brand"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("Photographer"), useValue: lenientModel(photographerModel) },
        { provide: getModelToken("Influencer"), useValue: lenientModel(jest.fn()) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel({}) },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  it("shows only verified brand contact fields on paid unlock", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "inv-1",
              influencerId: "inf-1",
              unlocked: true,
              status: "payment_confirmed",
              unlockType: "paid_collab_payment",
              campaignId: { _id: "camp-1", status: "active", brandId: "brand-1" },
              brandId: {
                brandName: "Brand One",
                email: "brand@example.com",
                phoneNumber: "9999999999",
                isEmailVerified: false,
                isMobileVerified: true,
              },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");

    expect(result[0].brandId.email).toBe("brand@example.com");
    expect(result[0].brandId.phoneNumber).toBe("9999999999");
  });

  it("shows brand contact fields after accepted + unlock", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "inv-1",
              influencerId: "inf-1",
              unlocked: true,
              status: "accepted",
              unlockType: "paid_collab_payment",
              campaignId: { _id: "camp-1", status: "active", brandId: "brand-1" },
              brandId: {
                brandName: "Brand One",
                email: "brand@example.com",
                phoneNumber: "9999999999",
                isEmailVerified: true,
                isMobileVerified: true,
              },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");

    expect(result[0].brandId.email).toBe("brand@example.com");
    expect(result[0].brandId.phoneNumber).toBe("9999999999");
  });

  it("hides invites when linked campaign is deleted", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "inv-live",
              influencerId: "inf-1",
              campaignId: { _id: "camp-live", status: "active", brandId: "brand-1" },
              brandId: { brandName: "Brand One" },
            },
            {
              _id: "inv-deleted",
              influencerId: "inf-1",
              campaignId: { _id: "camp-del", status: "deleted", brandId: "brand-1" },
              brandId: { brandName: "Brand One" },
            },
            {
              _id: "inv-soft",
              influencerId: "inf-1",
              campaignId: {
                _id: "camp-soft",
                status: "active",
                isDeleted: true,
                deletedAt: new Date().toISOString(),
                brandId: "brand-1",
              },
              brandId: { brandName: "Brand One" },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");

    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe("inv-live");
  });

  it("hides pending invites when linked campaign document is missing", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "inv-missing-campaign",
              influencerId: "inf-1",
              status: "pending",
              campaignId: null,
              brandId: { brandName: "Brand One" },
            },
            {
              _id: "inv-live",
              influencerId: "inf-1",
              status: "pending",
              campaignId: { _id: "camp-live", status: "active", brandId: "brand-1" },
              brandId: { brandName: "Brand One" },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");

    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe("inv-live");
  });

  it("hides photographer invites when linked campaign is missing/deleted", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "ph-missing",
              influencerId: "photo-1",
              recipientRole: "photographer",
              status: "pending",
              campaignId: null,
              brandId: { brandName: "Brand One" },
            },
            {
              _id: "ph-deleted",
              influencerId: "photo-1",
              recipientRole: "photographer",
              status: "accepted",
              campaignId: { _id: "camp-deleted", status: "deleted", brandId: "brand-1" },
              brandId: { brandName: "Brand One" },
            },
            {
              _id: "ph-live",
              influencerId: "photo-1",
              recipientRole: "photographer",
              status: "pending",
              campaignId: { _id: "camp-live", status: "active", brandId: "brand-1" },
              brandId: { brandName: "Brand One" },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByPhotographer("photo-1");

    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe("ph-live");
  });

  it("shows exact venue and shoot location details after accepted + unlock (influencer feed)", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "inv-1",
              influencerId: "inf-1",
              unlocked: true,
              status: "accepted",
              campaignId: {
                _id: "camp-1",
                status: "active",
                brandId: "brand-1",
                venueName: "Studio 44",
                venueAddress: "Road 1",
                venueGoogleMapUrl: "https://maps.example.com/v/1",
                shootLocationAddress: "Shoot Lane",
                shootLocationMapUrl: "https://maps.example.com/s/1",
                shootLocationNotes: "Bring lights",
              },
              brandId: { brandName: "Brand One" },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");

    expect(result[0].campaignId.venueName).toBe("Studio 44");
    expect(result[0].campaignId.venueAddress).toBe("Road 1");
    expect(result[0].campaignId.venueGoogleMapUrl).toBe("https://maps.example.com/v/1");
    expect(result[0].campaignId.shootLocationAddress).toBe("Shoot Lane");
    expect(result[0].campaignId.shootLocationMapUrl).toBe("https://maps.example.com/s/1");
    expect(result[0].campaignId.shootLocationNotes).toBe("Bring lights");
  });

  it("keeps exact venue and shoot location details after payment confirmation (photographer feed)", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "ph-1",
              influencerId: "photo-1",
              recipientRole: "photographer",
              unlocked: true,
              status: "payment_confirmed",
              campaignId: {
                _id: "camp-1",
                status: "active",
                brandId: "brand-1",
                venueName: "Studio 44",
                venueAddress: "Road 1",
                venueGoogleMapUrl: "https://maps.example.com/v/1",
                shootLocationAddress: "Shoot Lane",
                shootLocationMapUrl: "https://maps.example.com/s/1",
                shootLocationNotes: "Bring lights",
              },
              brandId: { brandName: "Brand One" },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByPhotographer("photo-1");

    expect(result[0].campaignId.venueName).toBe("Studio 44");
    expect(result[0].campaignId.venueAddress).toBe("Road 1");
    expect(result[0].campaignId.venueGoogleMapUrl).toBe(
      "https://maps.example.com/v/1",
    );
    expect(result[0].campaignId.shootLocationAddress).toBe("Shoot Lane");
    expect(result[0].campaignId.shootLocationMapUrl).toBe(
      "https://maps.example.com/s/1",
    );
    expect(result[0].campaignId.shootLocationNotes).toBe("Bring lights");
  });

  it("shows photographer-feed contact after accepted + unlock", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "ph-contact-1",
              influencerId: "photo-1",
              recipientRole: "photographer",
              unlocked: true,
              status: "accepted",
              campaignId: {
                _id: "camp-1",
                status: "active",
                brandId: "brand-1",
              },
              brandId: {
                brandName: "Brand One",
                email: "brand@example.com",
                phoneNumber: "9999999999",
              },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByPhotographer("photo-1");

    expect(result[0].brandId.email).toBe("brand@example.com");
    expect(result[0].brandId.phoneNumber).toBe("9999999999");
  });

  it("applies universal unlock rule across collaboration types", async () => {
    inviteModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "paid-accepted-unlocked",
              influencerId: "inf-1",
              unlocked: true,
              status: "accepted",
              campaignId: {
                _id: "camp-paid",
                status: "active",
                campaignType: "paid_collab",
                brandId: "brand-1",
                venueAddress: "Road A",
                venueGoogleMapUrl: "https://maps.example.com/a",
              },
              brandId: {
                brandName: "Brand One",
                email: "paid@example.com",
                phoneNumber: "9000000001",
              },
            },
            {
              _id: "product-accepted-locked",
              influencerId: "inf-1",
              unlocked: false,
              status: "accepted",
              campaignId: {
                _id: "camp-product",
                status: "active",
                campaignType: "product",
                brandId: "brand-1",
                venueAddress: "Road B",
                venueGoogleMapUrl: "https://maps.example.com/b",
              },
              brandId: {
                brandName: "Brand One",
                email: "product@example.com",
                phoneNumber: "9000000002",
              },
            },
            {
              _id: "invite-location-payment-confirmed",
              influencerId: "inf-1",
              unlocked: false,
              status: "payment_confirmed",
              campaignId: {
                _id: "camp-location",
                status: "active",
                campaignType: "invite_location",
                brandId: "brand-1",
                venueAddress: "Road C",
                venueGoogleMapUrl: "https://maps.example.com/c",
              },
              brandId: {
                brandName: "Brand One",
                email: "location@example.com",
                phoneNumber: "9000000003",
              },
            },
            {
              _id: "studio-accepted-unlocked",
              influencerId: "inf-1",
              unlocked: true,
              status: "accepted",
              campaignId: {
                _id: "camp-studio",
                status: "active",
                campaignType: "studio_collab",
                brandId: "brand-1",
                venueAddress: "Road D",
                venueGoogleMapUrl: "https://maps.example.com/d",
              },
              brandId: {
                brandName: "Brand One",
                email: "studio@example.com",
                phoneNumber: "9000000004",
              },
            },
            {
              _id: "event-accepted-locked",
              influencerId: "inf-1",
              unlocked: false,
              status: "accepted",
              campaignId: {
                _id: "camp-event",
                status: "active",
                campaignType: "event_coverage",
                brandId: "brand-1",
                venueAddress: "Road E",
                venueGoogleMapUrl: "https://maps.example.com/e",
              },
              brandId: {
                brandName: "Brand One",
                email: "event@example.com",
                phoneNumber: "9000000005",
              },
            },
          ]),
        }),
      }),
    });

    const result = await service.findByInfluencer("inf-1");
    const byId = new Map(result.map((row: any) => [row._id, row]));

    // accepted + unlocked => details visible
    expect(byId.get("paid-accepted-unlocked")?.brandId?.email).toBe("paid@example.com");
    expect(byId.get("paid-accepted-unlocked")?.campaignId?.venueAddress).toBe("Road A");

    // accepted + locked => details hidden
    expect(byId.get("product-accepted-locked")?.brandId?.email).toBeUndefined();
    expect(byId.get("product-accepted-locked")?.campaignId?.venueAddress).toBeUndefined();

    // payment_confirmed+ => details visible even if unlocked=false
    expect(byId.get("invite-location-payment-confirmed")?.brandId?.email).toBe("location@example.com");
    expect(byId.get("invite-location-payment-confirmed")?.campaignId?.venueAddress).toBe("Road C");

    // same rule for additional collaboration types
    expect(byId.get("studio-accepted-unlocked")?.brandId?.email).toBe("studio@example.com");
    expect(byId.get("studio-accepted-unlocked")?.campaignId?.venueAddress).toBe("Road D");

    expect(byId.get("event-accepted-locked")?.brandId?.email).toBeUndefined();
    expect(byId.get("event-accepted-locked")?.campaignId?.venueAddress).toBeUndefined();
  });
});

describe("CampaignInvitesService unlockContact policy", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let campaignModel: any;
  let plansService: any;

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.findById = jest.fn();

    campaignModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ campaignType: "paid_collab", status: "active" }),
        }),
      }),
    };

    plansService = {
      getUserPlanCapabilities: jest.fn().mockResolvedValue({ hasPremium: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: lenientModel(inviteModel) },
        { provide: getModelToken("CampaignSubmission"), useValue: lenientModel({}) },
        { provide: getModelToken("Campaign"), useValue: lenientModel(campaignModel) },
        { provide: getModelToken("Brand"), useValue: { findById: jest.fn() } },
        { provide: getModelToken("Photographer"), useValue: lenientModel({}) },
        { provide: getModelToken("Influencer"), useValue: lenientModel({}) },
        { provide: getModelToken("CampaignTransaction"), useValue: lenientModel({}) },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
        ...laterInviteProviders,
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  it("uses paid_collab_payment unlock type even for premium brand on paid_collab", async () => {
    const invite: any = {
      _id: "inv-1",
      brandId: "brand-1",
      campaignId: "camp-1",
      status: "payment_confirmed",
      unlocked: false,
      save: jest.fn().mockResolvedValue(undefined),
    };
    inviteModel.findById.mockResolvedValue(invite);

    const result = await service.unlockContact("inv-1", "brand-1");

    expect(result.unlockType).toBe("paid_collab_payment");
    expect(invite.unlockType).toBe("paid_collab_payment");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PlatformEvents: each business action records its event only after it succeeds.
// (Storage/normalization/dedupe itself is covered in platform-events.service.spec.ts.)
// ─────────────────────────────────────────────────────────────────────────────
describe("CampaignInvitesService – platform events", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let submissionModel: any;
  let campaignModel: any;
  let txModel: any;
  let platformEvents: { record: jest.Mock; recordOnce: jest.Mock };

  const eventsOfType = (type: string) =>
    platformEvents.record.mock.calls
      .map((c) => c[0])
      .filter((e) => e.eventType === type);

  function doc(fields: any) {
    const d: any = { ...fields };
    d.save = jest.fn().mockImplementation(() => Promise.resolve(d));
    return d;
  }

  beforeEach(async () => {
    platformEvents = {
      record: jest.fn().mockResolvedValue(true),
      recordOnce: jest.fn().mockResolvedValue(0),
    };

    inviteModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({
        ...data,
        _id: "inv-new",
        createdAt: new Date("2026-06-10T10:00:00Z"),
      }),
    }));
    inviteModel.findById = jest.fn();
    inviteModel.findOne = jest.fn(() => queryOf(null));
    inviteModel.find = jest.fn(() => queryOf([]));
    inviteModel.countDocuments = jest.fn().mockResolvedValue(0);
    inviteModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    inviteModel.create = jest.fn();

    submissionModel = {
      findOne: jest.fn(),
      create: jest.fn(),
      find: jest.fn(() => queryOf([])),
      findById: jest.fn(),
    };
    campaignModel = jest.fn();
    campaignModel.findById = jest.fn();
    txModel = {
      find: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue(undefined),
    };

    const verifiedProfile = {
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          name: "X",
          isEmailVerified: true,
          isMobileVerified: true,
          socialMedia: [],
        }),
      }),
      lean: jest.fn().mockResolvedValue({ name: "X", socialMedia: [] }),
    };
    const brandModel: any = jest.fn();
    brandModel.findById = jest.fn().mockReturnValue(verifiedProfile);
    const influencerModel: any = jest.fn();
    influencerModel.findById = jest.fn().mockReturnValue(verifiedProfile);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        {
          provide: getModelToken("CampaignInvite"),
          useValue: lenientModel(inviteModel),
        },
        {
          provide: getModelToken("CampaignSubmission"),
          useValue: lenientModel(submissionModel),
        },
        {
          provide: getModelToken("Campaign"),
          useValue: lenientModel(campaignModel),
        },
        { provide: getModelToken("Brand"), useValue: lenientModel(brandModel) },
        {
          provide: getModelToken("Photographer"),
          useValue: lenientModel(jest.fn()),
        },
        {
          provide: getModelToken("Influencer"),
          useValue: lenientModel(influencerModel),
        },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: lenientModel(txModel),
        },
        {
          provide: PlansService,
          useValue: {
            getUserPlanCapabilities: jest.fn().mockResolvedValue({
              hasPremium: false,
              features: [{ key: "canInviteUsers", value: true }],
              limits: [{ key: "maxInvitesPerCampaign", value: -1 }],
            }),
          },
        },
        {
          provide: PushService,
          useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NotificationsService,
          useValue: { createForUser: jest.fn().mockResolvedValue(undefined) },
        },
        ...laterInviteProviders.filter(
          (p) => p.provide !== PlatformEventsService,
        ),
        { provide: PlatformEventsService, useValue: platformEvents },
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  const activeCampaign = {
    _id: "camp1",
    brandId: "brand1",
    title: "Camp",
    status: "active",
    campaignMode: "invite_only",
    ownerType: "brand",
    pricePerInfluencer: 500000,
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-08-31"),
    timelineStart: new Date("2026-06-01"),
    timelineEnd: new Date("2026-08-31"),
  };

  describe("creator_invited", () => {
    it("records the invite after it is saved", async () => {
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));

      await service.create("brand1", {
        campaignId: "camp1",
        influencerId: "inf1",
        selectedPlatform: "Instagram",
      });

      const [event] = eventsOfType("creator_invited");
      expect(event).toMatchObject({
        userId: "brand1",
        userRole: "brand",
        brandId: "brand1",
        campaignId: "camp1",
        influencerId: "inf1",
        inviteId: "inv-new",
        recipientRole: "influencer",
        platform: "Instagram",
        dedupeKey: "creator_invited:inv-new",
        metadata: expect.objectContaining({ campaignLiveAtInvite: true }),
      });
      expect(event.timestamp).toEqual(new Date("2026-06-10T10:00:00Z"));
    });

    it("Stage 3B-4: admin attribution comes only from options, never the request body", async () => {
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));

      await service.create("brand1", {
        campaignId: "camp1",
        influencerId: "inf1",
        invitedByAdminId: "spoofed",
        invitedByAdminAt: new Date("2020-01-01"),
      });
      expect(inviteModel.mock.calls[0][0]).toMatchObject({
        invitedByAdminId: undefined,
        invitedByAdminAt: undefined,
      });
      expect(eventsOfType("creator_invited")[0].metadata).toMatchObject({
        invitedByAdmin: false,
      });

      await service.create(
        "brand1",
        { campaignId: "camp1", influencerId: "inf1" },
        { invitedByAdminId: "admin-1" },
      );
      expect(inviteModel.mock.calls[1][0]).toMatchObject({
        brandId: "brand1",
        invitedByAdminId: "admin-1",
        invitedByAdminAt: expect.any(Date),
      });
      expect(eventsOfType("creator_invited")[1].metadata).toMatchObject({
        invitedByAdmin: true,
      });
    });

    it("Stage 3B-3/4: the creator is notified only after the invite is saved", async () => {
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
      const push = (service as any).pushService.sendToUser as jest.Mock;
      const inbox = (service as any).notificationsService
        .createForUser as jest.Mock;

      inviteModel.mockImplementationOnce((data: any) => ({
        ...data,
        save: jest.fn().mockRejectedValue(new Error("write failed")),
      }));
      await expect(
        service.create(
          "brand1",
          { campaignId: "camp1", influencerId: "inf1" },
          { invitedByAdminId: "admin-1" },
        ),
      ).rejects.toThrow("write failed");
      expect(push).not.toHaveBeenCalled();
      expect(inbox).not.toHaveBeenCalled();
      expect(eventsOfType("creator_invited")).toHaveLength(0);

      await service.create(
        "brand1",
        { campaignId: "camp1", influencerId: "inf1" },
        { invitedByAdminId: "admin-1" },
      );
      expect(push).toHaveBeenCalledTimes(1);
      expect(inbox).toHaveBeenCalledTimes(1);
    });

    it("Stage 3B-4: isCampaignOwner matches the owner id or an owner username", async () => {
      expect(await service.isCampaignOwner("brand1", "brand1")).toBe(true);
      expect(await service.isCampaignOwner("", "brand1")).toBe(false);
      expect(await service.isCampaignOwner("brand1", "")).toBe(false);
      const resolve = jest
        .spyOn(service as any, "resolveOwnerIdentifiers")
        .mockResolvedValue(["64b0000000000000000000b1", "acme"]);
      expect(
        await service.isCampaignOwner("acme", "64b0000000000000000000b1"),
      ).toBe(true);
      expect(
        await service.isCampaignOwner("other", "64b0000000000000000000b1"),
      ).toBe(false);
      resolve.mockRestore();
    });

    it("Stage 3B-4: invitedRecipientIds matches both campaignId forms", async () => {
      inviteModel.distinct = jest
        .fn()
        .mockResolvedValue(["64b0000000000000000000a1"]);
      const ids = await service.invitedRecipientIds(
        "64b0000000000000000000c1",
        ["64b0000000000000000000a1", "not-an-id"],
      );
      expect([...ids]).toEqual(["64b0000000000000000000a1"]);
      const [field, filter] = inviteModel.distinct.mock.calls[0];
      expect(field).toBe("influencerId");
      expect(filter.campaignId.$in.map(String)).toEqual([
        "64b0000000000000000000c1",
        "64b0000000000000000000c1",
      ]);
      expect(filter.influencerId.$in.map(String)).toEqual([
        "64b0000000000000000000a1",
      ]);
    });

    it("records nothing when the invite is rejected", async () => {
      campaignModel.findById.mockReturnValue(
        queryOf({
          ...activeCampaign,
          acceptanceDeadline: new Date(Date.now() - 60_000),
        }),
      );
      await expect(
        service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
      ).rejects.toThrow(BadRequestException);
      expect(platformEvents.record).not.toHaveBeenCalled();
    });
  });

  describe("creator_applied", () => {
    it("records the application after the invite row is created", async () => {
      campaignModel.findById.mockReturnValue(
        queryOf({ ...activeCampaign, campaignMode: "tier_filtered_open" }),
      );
      inviteModel.create.mockResolvedValue({
        _id: "inv-app",
        campaignId: "camp1",
        influencerId: "inf1",
        brandId: "brand1",
      });

      await service.applyToCampaign("inf1", "camp1");

      expect(eventsOfType("creator_applied")[0]).toMatchObject({
        userId: "inf1",
        userRole: "influencer",
        campaignId: "camp1",
        inviteId: "inv-app",
        dedupeKey: "creator_applied:inv-app",
      });
    });

    it("records nothing for a duplicate application", async () => {
      campaignModel.findById.mockReturnValue(
        queryOf({ ...activeCampaign, campaignMode: "tier_filtered_open" }),
      );
      inviteModel.findOne.mockReturnValue(queryOf({ _id: "existing" }));
      await expect(service.applyToCampaign("inf1", "camp1")).rejects.toThrow(
        BadRequestException,
      );
      expect(platformEvents.record).not.toHaveBeenCalled();
    });
  });

  describe("invite_accepted / invite_declined", () => {
    it("records invite_accepted with the accept time and chosen platform", async () => {
      const invite = doc({
        _id: "inv1",
        influencerId: "inf1",
        brandId: "brand1",
        campaignId: "camp1",
        status: "pending",
      });
      inviteModel.findById.mockResolvedValue(invite);
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));

      await service.respond("inv1", "inf1", "accepted", "2026-07-15");

      const [event] = eventsOfType("invite_accepted");
      expect(event).toMatchObject({
        userId: "inf1",
        userRole: "influencer",
        inviteId: "inv1",
        dedupeKey: "invite_accepted:inv1",
      });
      expect(event.timestamp).toBe(invite.acceptedAt);
    });

    it("records invite_declined", async () => {
      const invite = doc({
        _id: "inv1",
        influencerId: "inf1",
        brandId: "brand1",
        campaignId: "camp1",
        status: "pending",
      });
      inviteModel.findById.mockResolvedValue(invite);

      await service.respond("inv1", "inf1", "declined");

      expect(eventsOfType("invite_declined")[0]).toMatchObject({
        inviteId: "inv1",
        dedupeKey: "invite_declined:inv1",
      });
      expect(eventsOfType("invite_accepted")).toHaveLength(0);
    });

    it("records nothing when the accept fails validation", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "pending",
        }),
      );
      campaignModel.findById.mockReturnValue(
        queryOf({
          ...activeCampaign,
          acceptanceDeadline: new Date(Date.now() - 1000),
        }),
      );
      await expect(
        service.respond("inv1", "inf1", "accepted", "2026-07-15"),
      ).rejects.toThrow(BadRequestException);
      expect(platformEvents.record).not.toHaveBeenCalled();
    });

    it("records nothing when the invite was already answered", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "accepted",
        }),
      );
      await expect(service.respond("inv1", "inf1", "declined")).rejects.toThrow(
        BadRequestException,
      );
      expect(platformEvents.record).not.toHaveBeenCalled();
    });

    it("records invite_accepted when the owner accepts the creator's counter-offer", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "counter_sent",
          counterOffer: {
            status: "sent",
            requestedAmount: 700,
            requestedAmountPaise: 70000,
          },
        }),
      );
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));

      await service.respondToCounter("inv1", "brand1", "accept");

      expect(eventsOfType("invite_accepted")[0]).toMatchObject({
        userId: "brand1",
        userRole: "brand",
        inviteId: "inv1",
        metadata: expect.objectContaining({ viaCounterAcceptedByOwner: true }),
      });
    });

    it("records nothing when the owner declines the counter (invite goes back to pending)", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "counter_sent",
          counterOffer: { status: "sent", requestedAmountPaise: 70000 },
        }),
      );
      await service.respondToCounter("inv1", "brand1", "decline");
      expect(platformEvents.record).not.toHaveBeenCalled();
    });
  });

  describe("invite_viewed", () => {
    const feed = [
      {
        _id: "inv-open",
        influencerId: "inf1",
        status: "pending",
        campaignId: { _id: "camp1", status: "active", brandId: "brand1" },
        brandId: { _id: "brand1" },
      },
      {
        _id: "inv-done",
        influencerId: "inf1",
        status: "accepted",
        campaignId: { _id: "camp1", status: "active", brandId: "brand1" },
        brandId: { _id: "brand1" },
      },
    ];

    it("records a once-only view for each still-open invite shown in the feed", async () => {
      inviteModel.find.mockReturnValue(queryOf(feed));

      await service.findByInfluencer("inf1", "campaign");

      expect(platformEvents.recordOnce).toHaveBeenCalledTimes(1);
      const inputs = platformEvents.recordOnce.mock.calls[0][0];
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        eventType: "invite_viewed",
        userId: "inf1",
        inviteId: "inv-open",
        dedupeKey: "invite_viewed:inv-open",
      });
    });

    it("does not count the scope-less background lookup (brand profile page) as a view", async () => {
      inviteModel.find.mockReturnValue(queryOf(feed));
      await service.findByInfluencer("inf1");
      expect(platformEvents.recordOnce).not.toHaveBeenCalled();
    });

    it("records views from the photographer feed", async () => {
      inviteModel.find.mockReturnValue(
        queryOf(feed.map((i) => ({ ...i, recipientRole: "photographer" }))),
      );
      await service.findByPhotographer("inf1");
      expect(platformEvents.recordOnce.mock.calls[0][0][0]).toMatchObject({
        userRole: "photographer",
        recipientRole: "photographer",
        dedupeKey: "invite_viewed:inv-open",
      });
    });

    it("returns the feed without waiting for the view write (non-blocking)", async () => {
      inviteModel.find.mockReturnValue(queryOf(feed));
      // A write that never completes must not hold up the response.
      platformEvents.recordOnce.mockReturnValue(new Promise(() => undefined));
      const result = await service.findByInfluencer("inf1", "campaign");
      expect(result).toHaveLength(2);
      expect(platformEvents.recordOnce).toHaveBeenCalledTimes(1);
    });

    it("still returns the feed when event recording fails", async () => {
      inviteModel.find.mockReturnValue(queryOf(feed));
      platformEvents.recordOnce.mockRejectedValue(new Error("db down"));
      await expect(
        service.findByInfluencer("inf1", "campaign"),
      ).resolves.toHaveLength(2);
    });
  });

  describe("content_submitted / content_approved / content_rejected", () => {
    it("records content_submitted with the detected platform", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "working",
        }),
      );
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
      submissionModel.findOne.mockResolvedValue(null);
      submissionModel.create.mockImplementation((d: any) =>
        Promise.resolve({ _id: "sub1", ...d }),
      );

      await service.submitPost("inv1", "inf1", {
        postUrl: "https://www.instagram.com/p/abc",
      });

      expect(eventsOfType("content_submitted")[0]).toMatchObject({
        userId: "inf1",
        platform: "instagram",
        inviteId: "inv1",
        dedupeKey: "content_submitted:inv1:0",
        metadata: expect.objectContaining({
          submissionId: "sub1",
          isResubmission: false,
        }),
      });
    });

    it("records nothing when the submission is rejected", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "pending",
        }),
      );
      await expect(
        service.submitPost("inv1", "inf1", {
          postUrl: "https://www.instagram.com/p/abc",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(platformEvents.record).not.toHaveBeenCalled();
    });

    it("records content_approved when the owner approves", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "submitted",
        }),
      );
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
      submissionModel.findOne.mockResolvedValue(
        doc({
          _id: "sub1",
          status: "submitted",
          postPlatform: "instagram",
          submittedAt: new Date(Date.now() - 72 * 3600_000),
        }),
      );

      await service.reviewSubmission("inv1", "brand1", "approve");

      expect(eventsOfType("content_approved")[0]).toMatchObject({
        userId: "brand1",
        userRole: "brand",
        platform: "instagram",
        dedupeKey: "content_approved:inv1",
        metadata: expect.objectContaining({ via: "owner_review" }),
      });
    });

    it("records nothing while the review window is still open", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "submitted",
        }),
      );
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
      submissionModel.findOne.mockResolvedValue(
        doc({ _id: "sub1", status: "submitted", submittedAt: new Date() }),
      );

      await expect(
        service.reviewSubmission("inv1", "brand1", "approve"),
      ).rejects.toThrow(BadRequestException);
      expect(platformEvents.record).not.toHaveBeenCalled();
    });

    it("records no content event when the owner disputes (not a final outcome)", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "submitted",
        }),
      );
      campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
      submissionModel.findOne.mockResolvedValue(
        doc({ _id: "sub1", status: "submitted", submittedAt: new Date() }),
      );

      await service.reviewSubmission(
        "inv1",
        "brand1",
        "dispute",
        undefined,
        "The mention of the brand handle is missing entirely.",
        "Missing mention",
      );
      expect(eventsOfType("content_approved")).toHaveLength(0);
      expect(eventsOfType("content_rejected")).toHaveLength(0);
    });

    it("records content_approved as a system action when a stale submission auto-completes", async () => {
      const submission = doc({
        _id: "sub1",
        inviteId: "inv1",
        status: "submitted",
        postPlatform: "youtube",
      });
      submissionModel.find.mockReturnValue(queryOf([{ _id: "sub1" }]));
      submissionModel.findById.mockResolvedValue(submission);
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "submitted",
        }),
      );

      await service.autoApproveStaleSubmissions();

      expect(eventsOfType("content_approved")[0]).toMatchObject({
        userRole: "system",
        platform: "youtube",
        metadata: expect.objectContaining({ via: "auto_complete" }),
      });
    });

    it("records content_rejected when an admin resolves a dispute for the host", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          brandId: "brand1",
          campaignId: "camp1",
          status: "disputed",
          reportedIssue: { reportedAt: new Date() },
        }),
      );
      submissionModel.findOne.mockResolvedValue(
        doc({ _id: "sub1", status: "disputed" }),
      );

      await service.adminResolveDispute("inv1", { outcome: "withdrawn" });

      expect(eventsOfType("content_rejected")[0]).toMatchObject({
        userRole: "admin",
        dedupeKey: "content_rejected:inv1",
        metadata: expect.objectContaining({ via: "dispute_admin" }),
      });
    });

    it("records no content event for a resolved report that never had a submission", async () => {
      inviteModel.findById.mockResolvedValue(
        doc({
          _id: "inv1",
          influencerId: "inf1",
          status: "working",
          reportedIssue: { reportedAt: new Date() },
        }),
      );
      submissionModel.findOne.mockResolvedValue(null);

      await service.adminResolveDispute("inv1", { outcome: "withdrawn" });
      expect(eventsOfType("content_approved")).toHaveLength(0);
      expect(eventsOfType("content_rejected")).toHaveLength(0);
      expect(eventsOfType("invite_withdrawn")[0]).toMatchObject({
        userRole: "admin",
        metadata: { reason: "dispute_refund", previousStatus: "working" },
      });
    });
  });

  describe("Stage 1.5 lifecycle events", () => {
    const openInvite = (overrides: any = {}) =>
      doc({
        _id: "inv1",
        influencerId: "inf1",
        brandId: "brand1",
        campaignId: "camp1",
        status: "pending",
        ...overrides,
      });

    describe("invite_withdrawn", () => {
      it("records an owner withdrawal with the prior status", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "accepted" }),
        );

        await service.withdrawInvite(
          "inv1",
          "brand1",
          "Changed plans — call 98xxxxxx",
        );

        const [event] = eventsOfType("invite_withdrawn");
        expect(event).toMatchObject({
          userId: "brand1",
          userRole: "brand",
          inviteId: "inv1",
          dedupeKey: "invite_withdrawn:inv1",
          metadata: { reason: "owner", previousStatus: "accepted" },
        });
        // The owner's free-text reason is not copied into the event.
        expect(JSON.stringify(event)).not.toContain("98xxxxxx");
      });

      it("records nothing when the withdrawal is refused", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "working" }),
        );
        await expect(service.withdrawInvite("inv1", "brand1")).rejects.toThrow(
          BadRequestException,
        );
        expect(platformEvents.record).not.toHaveBeenCalled();
      });

      it("records auto_close for each invite the acceptance closed out", async () => {
        inviteModel.findById.mockResolvedValue(openInvite());
        campaignModel.findById.mockReturnValue(
          queryOf({ ...activeCampaign, maxInfluencers: 1 }),
        );
        inviteModel.countDocuments
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(1);
        inviteModel.find
          .mockReturnValueOnce(
            queryOf([
              {
                _id: "inv2",
                status: "pending",
                campaignId: "camp1",
                influencerId: "inf2",
              },
              {
                _id: "inv3",
                status: "counter_sent",
                campaignId: "camp1",
                influencerId: "inf3",
              },
            ]),
          )
          // inv3 was accepted between the snapshot and the update, so only inv2 closed.
          .mockReturnValueOnce(queryOf([{ _id: "inv2" }]));

        await service.respond("inv1", "inf1", "accepted", "2026-07-15");

        const withdrawn = eventsOfType("invite_withdrawn");
        expect(withdrawn).toHaveLength(1);
        expect(withdrawn[0]).toMatchObject({
          inviteId: "inv2",
          userRole: "system",
          metadata: { reason: "auto_close", previousStatus: "pending" },
        });
        expect(eventsOfType("invite_accepted")).toHaveLength(1);
      });

      it("still completes the acceptance when the auto-close snapshot fails", async () => {
        const invite = openInvite();
        inviteModel.findById.mockResolvedValue(invite);
        campaignModel.findById.mockReturnValue(
          queryOf({ ...activeCampaign, maxInfluencers: 1 }),
        );
        inviteModel.countDocuments
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(1);
        inviteModel.find.mockImplementationOnce(() => {
          throw new Error("db blip");
        });

        await service.respond("inv1", "inf1", "accepted", "2026-07-15");

        expect(invite.status).toBe("accepted");
        expect(inviteModel.updateMany).toHaveBeenCalled();
        expect(eventsOfType("invite_withdrawn")).toHaveLength(0);
      });

      it("records expired_never_accepted when the campaign ends first", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "counter_sent" }),
        );
        await service.expireNeverAcceptedInvite(
          "inv1",
          "Campaign ended before this invite was accepted.",
        );
        expect(eventsOfType("invite_withdrawn")[0]).toMatchObject({
          userRole: "system",
          metadata: {
            reason: "expired_never_accepted",
            previousStatus: "counter_sent",
          },
        });
      });

      it("records expired_unsubmitted, but not while a report blocks the expiry", async () => {
        inviteModel.findById.mockResolvedValueOnce(
          openInvite({
            status: "working",
            reportedIssue: { reportedAt: new Date() },
          }),
        );
        await service.expireUnsubmittedInvite(
          "inv1",
          "Posting deadline and grace period expired with no submission.",
        );
        expect(platformEvents.record).not.toHaveBeenCalled();

        inviteModel.findById.mockResolvedValueOnce(
          openInvite({ status: "working" }),
        );
        await service.expireUnsubmittedInvite(
          "inv1",
          "Posting deadline and grace period expired with no submission.",
        );
        expect(eventsOfType("invite_withdrawn")[0]).toMatchObject({
          metadata: {
            reason: "expired_unsubmitted",
            previousStatus: "working",
          },
        });
      });
    });

    describe("counter_offer_sent", () => {
      it("records the creator's counter-offer", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ selectedPlatform: "Instagram" }),
        );
        campaignModel.findById.mockReturnValue(
          queryOf({
            ...activeCampaign,
            socialMedia: [
              {
                platform: "Instagram",
                contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
              },
            ],
          }),
        );

        await service.respond(
          "inv1",
          "inf1",
          "counter_sent",
          "2026-07-15",
          "Instagram",
          "Reel",
          7000,
          "Can you do 7k?",
        );

        const [event] = eventsOfType("counter_offer_sent");
        expect(event).toMatchObject({
          userId: "inf1",
          userRole: "influencer",
          dedupeKey: "counter_offer_sent:inv1:recipient",
          metadata: expect.objectContaining({
            by: "recipient",
            selectedContentType: "Reel",
          }),
        });
        expect(event.metadata.requestedAmountPaise).toBeGreaterThan(0);
        expect(JSON.stringify(event)).not.toContain("Can you do 7k");
        expect(eventsOfType("invite_accepted")).toHaveLength(0);
      });

      it("regression: invite_accepted is later than counter_offer_sent when the owner accepts the counter", async () => {
        const sentAt = new Date("2026-07-01T10:00:00.000Z");
        const acceptedLater = new Date("2026-07-01T11:30:00.000Z");
        jest.useFakeTimers({
          now: sentAt,
          doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
        });
        try {
          const invite = openInvite({ selectedPlatform: "Instagram" });
          inviteModel.findById.mockResolvedValue(invite);
          campaignModel.findById.mockReturnValue(
            queryOf({
              ...activeCampaign,
              socialMedia: [
                {
                  platform: "Instagram",
                  contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
                },
              ],
            }),
          );

          await service.respond(
            "inv1",
            "inf1",
            "counter_sent",
            "2026-07-15",
            "Instagram",
            "Reel",
            7000,
          );
          // The operational field is stamped at counter-send time — that is the trap.
          expect(invite.acceptedAt).toEqual(sentAt);

          jest.setSystemTime(acceptedLater);
          await service.respondToCounter("inv1", "brand1", "accept");
        } finally {
          jest.useRealTimers();
        }

        const [counter] = eventsOfType("counter_offer_sent");
        const [accepted] = eventsOfType("invite_accepted");
        expect(counter.timestamp).toEqual(sentAt);
        expect(accepted.timestamp).toEqual(acceptedLater);
        expect(counter.timestamp.getTime()).toBeLessThan(
          accepted.timestamp.getTime(),
        );
      });

      it("records the owner's revised counter", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({
            status: "counter_sent",
            counterOffer: {
              status: "sent",
              requestedAmount: 700,
              requestedAmountPaise: 70000,
            },
          }),
        );

        await service.respondToCounter(
          "inv1",
          "brand1",
          "counter",
          "Can do 600",
          600,
        );

        expect(eventsOfType("counter_offer_sent")[0]).toMatchObject({
          userId: "brand1",
          userRole: "brand",
          dedupeKey: "counter_offer_sent:inv1:owner",
          metadata: expect.objectContaining({
            by: "owner",
            offeredAmountPaise: 70000,
          }),
        });
      });

      it("records nothing when a second revision is refused", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({
            status: "counter_sent",
            counterOffer: { status: "brand_sent" },
          }),
        );
        await expect(
          service.respondToCounter("inv1", "brand1", "counter", "", 500),
        ).rejects.toThrow(BadRequestException);
        expect(platformEvents.record).not.toHaveBeenCalled();
      });
    });

    describe("work_started", () => {
      it("records the move to working", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({
            status: "payment_confirmed",
            selectedPlatform: "YouTube",
          }),
        );
        campaignModel.findById.mockReturnValue(queryOf(activeCampaign));

        await service.startWork("inv1", "inf1");

        expect(eventsOfType("work_started")[0]).toMatchObject({
          userId: "inf1",
          platform: "YouTube",
          dedupeKey: "work_started:inv1",
          metadata: expect.objectContaining({
            previousStatus: "payment_confirmed",
          }),
        });
      });

      it("records nothing when work had already started (idempotent call)", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "working" }),
        );
        await service.startWork("inv1", "inf1");
        expect(platformEvents.record).not.toHaveBeenCalled();
      });

      it("records nothing when work cannot start yet", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "pending" }),
        );
        await expect(service.startWork("inv1", "inf1")).rejects.toThrow(
          BadRequestException,
        );
        expect(platformEvents.record).not.toHaveBeenCalled();
      });
    });

    describe("content_disputed", () => {
      it("records the owner's dispute with the chosen issue but not the free-text description", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "submitted" }),
        );
        campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
        submissionModel.findOne.mockResolvedValue(
          doc({
            _id: "sub1",
            status: "submitted",
            postPlatform: "instagram",
            submittedAt: new Date(),
          }),
        );

        await service.reviewSubmission(
          "inv1",
          "brand1",
          "dispute",
          undefined,
          "The @brand handle is missing, contact me at owner@example.com",
          "Missing mention",
        );

        const [event] = eventsOfType("content_disputed");
        expect(event).toMatchObject({
          userId: "brand1",
          userRole: "brand",
          platform: "instagram",
          dedupeKey: "content_disputed:inv1:0",
          metadata: expect.objectContaining({
            issueReason: "Missing mention",
            isFinalRejection: false,
            submissionId: "sub1",
          }),
        });
        expect(JSON.stringify(event)).not.toContain("owner@example.com");
      });

      it("keys a dispute of the resubmission separately (final rejection)", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "submitted" }),
        );
        campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
        submissionModel.findOne.mockResolvedValue(
          doc({
            _id: "sub1",
            status: "submitted",
            resubmissionCount: 1,
            submittedAt: new Date(),
          }),
        );

        await service.reviewSubmission(
          "inv1",
          "brand1",
          "dispute",
          "Still wrong",
        );

        expect(eventsOfType("content_disputed")[0]).toMatchObject({
          dedupeKey: "content_disputed:inv1:1",
          metadata: expect.objectContaining({
            isFinalRejection: true,
            escalatedToAdmin: true,
          }),
        });
      });

      it("records nothing when the dispute is invalid", async () => {
        inviteModel.findById.mockResolvedValue(
          openInvite({ status: "submitted" }),
        );
        campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
        submissionModel.findOne.mockResolvedValue(
          doc({ _id: "sub1", status: "submitted", submittedAt: new Date() }),
        );
        await expect(
          service.reviewSubmission(
            "inv1",
            "brand1",
            "dispute",
            undefined,
            "too short",
            "Missing mention",
          ),
        ).rejects.toThrow(BadRequestException);
        expect(platformEvents.record).not.toHaveBeenCalled();
      });
    });
  });

  it("never records creator_selected (no such business action exists yet)", async () => {
    campaignModel.findById.mockReturnValue(queryOf(activeCampaign));
    await service.create("brand1", {
      campaignId: "camp1",
      influencerId: "inf1",
    });
    expect(eventsOfType("creator_selected")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invite_viewed end-to-end: real PlatformEventsService over a store that enforces
// the unique dedupeKey index, so refresh/duplicate behavior is what production does.
// ─────────────────────────────────────────────────────────────────────────────
describe("CampaignInvitesService – invite_viewed with real PlatformEventsService", () => {
  let service: CampaignInvitesService;
  let rows: any[];
  let inviteModel: any;

  const OPEN = "64b0000000000000000000a1";
  const ACCEPTED = "64b0000000000000000000a2";
  const CAMPAIGN = "64b0000000000000000000a3";
  const BRAND = "64b0000000000000000000a4";
  const CREATOR = "64b0000000000000000000a5";

  const feed = () => [
    {
      _id: OPEN,
      influencerId: CREATOR,
      status: "pending",
      campaignId: { _id: CAMPAIGN, status: "active", brandId: BRAND },
      brandId: { _id: BRAND },
    },
    {
      _id: ACCEPTED,
      influencerId: CREATOR,
      status: "accepted",
      campaignId: { _id: CAMPAIGN, status: "active", brandId: BRAND },
      brandId: { _id: BRAND },
    },
  ];

  /** Lets the fire-and-forget view write finish before asserting on the store. */
  const settle = () => new Promise((r) => setImmediate(r));

  beforeEach(async () => {
    rows = [];
    const eventModel = {
      find: jest.fn((q: any) =>
        queryOf(rows.filter((r) => q.dedupeKey.$in.includes(r.dedupeKey))),
      ),
      insertMany: jest.fn((docs: any[]) => {
        const dupes = docs.filter((d) =>
          rows.some((r) => r.dedupeKey === d.dedupeKey),
        );
        docs.filter((d) => !dupes.includes(d)).forEach((d) => rows.push(d));
        return dupes.length
          ? Promise.reject(
              Object.assign(new Error("E11000"), {
                writeErrors: dupes.map(() => ({ code: 11000 })),
              }),
            )
          : Promise.resolve(docs);
      }),
      create: jest.fn(),
    };
    inviteModel = jest.fn();
    inviteModel.find = jest.fn(() => queryOf(feed()));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        PlatformEventsService,
        { provide: getModelToken("PlatformEvent"), useValue: eventModel },
        {
          provide: getModelToken("CampaignInvite"),
          useValue: lenientModel(inviteModel),
        },
        {
          provide: getModelToken("CampaignSubmission"),
          useValue: lenientModel({}),
        },
        { provide: getModelToken("Campaign"), useValue: lenientModel({}) },
        { provide: getModelToken("Brand"), useValue: lenientModel(jest.fn()) },
        {
          provide: getModelToken("Photographer"),
          useValue: lenientModel(jest.fn()),
        },
        {
          provide: getModelToken("Influencer"),
          useValue: lenientModel(jest.fn()),
        },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: lenientModel({}),
        },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: inertService() },
        { provide: NotificationsService, useValue: inertService() },
        ...laterInviteProviders.filter(
          (p) => p.provide !== PlatformEventsService,
        ),
      ],
    }).compile();
    service = module.get(CampaignInvitesService);
  });

  it("records one view per open invite, however often the feed is refreshed", async () => {
    for (let i = 0; i < 5; i++) {
      await service.findByInfluencer(CREATOR, "campaign");
      await settle();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "invite_viewed",
      dedupeKey: `invite_viewed:${OPEN}`,
    });
    expect(String(rows[0].inviteId)).toBe(OPEN);
    expect(String(rows[0].userId)).toBe(CREATOR);
    expect(String(rows[0].brandId)).toBe(BRAND);
  });

  it("records one view when two feed loads race", async () => {
    await Promise.all([
      service.findByInfluencer(CREATOR, "campaign"),
      service.findByInfluencer(CREATOR, "collaboration"),
    ]);
    await settle();
    expect(rows).toHaveLength(1);
  });

  it("records nothing for the scope-less background lookup", async () => {
    await service.findByInfluencer(CREATOR);
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("records nothing for a requester who has no invites (e.g. a brand hitting the endpoint)", async () => {
    inviteModel.find.mockReturnValue(queryOf([]));
    await service.findByInfluencer(BRAND, "campaign");
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("records no views for already-answered invites", async () => {
    inviteModel.find.mockReturnValue(queryOf([feed()[1]]));
    await service.findByInfluencer(CREATOR, "campaign");
    await settle();
    expect(rows).toHaveLength(0);
  });
});

describe("latestOpenPostingDeadline (auto-close guard)", () => {
  const make = (mode: string | undefined, posts: Array<string | null>) => {
    const service: any = Object.create(CampaignInvitesService.prototype);
    const chain = (v: any) => ({
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }),
    });
    service.campaignModel = {
      findById: jest
        .fn()
        .mockReturnValue(
          chain(mode === undefined ? null : { postingDeadlineMode: mode }),
        ),
    };
    service.inviteModel = {
      find: jest
        .fn()
        .mockReturnValue(
          chain(
            posts
              .filter(Boolean)
              .map((p) => ({ selectedPostDate: new Date(p as string) })),
          ),
        ),
    };
    service.appSettingsModel = {
      findOne: () => ({
        lean: () => Promise.resolve({ campaignAutoCloseGraceHours: 24 }),
      }),
    };
    return service as CampaignInvitesService;
  };

  it("grace_24h: CMP-24 post date 5 Oct → window closes 7 Oct 00:00 UTC (not 6 Oct)", async () => {
    const s = make("grace_24h", ["2026-10-05T00:00:00.000Z"]);
    expect((await s.latestOpenPostingDeadline("c24"))?.toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });

  it("strict: no grace — closes at the end of the post date", async () => {
    const s = make("strict", ["2026-10-05T00:00:00.000Z"]);
    expect((await s.latestOpenPostingDeadline("c24"))?.toISOString()).toBe(
      "2026-10-06T00:00:00.000Z",
    );
  });

  it("takes the latest window across creators; null when nobody has a post date", async () => {
    const s = make("grace_24h", [
      "2026-10-03T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    ]);
    expect((await s.latestOpenPostingDeadline("c24"))?.toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect(
      await make("grace_24h", []).latestOpenPostingDeadline("c24"),
    ).toBeNull();
  });

  it("only looks at accepted-but-unsubmitted invites with a post date", async () => {
    const s = make("grace_24h", []);
    await s.latestOpenPostingDeadline("c24");
    expect((s as any).inviteModel.find).toHaveBeenCalledWith({
      campaignId: { $in: ["c24", "c24"] },
      status: { $in: ["accepted", "payment_confirmed", "working"] },
      selectedPostDate: { $ne: null },
    });
  });
});

describe("getBrandAttentionCounts (brand dashboard banner)", () => {
  const BRAND = "6a1ad8999dadc0c4f6ccbbca";
  const make = (campaigns: any[]) => {
    const service: any = Object.create(CampaignInvitesService.prototype);
    service.attentionCache = new Map();
    service.ATTENTION_CACHE_TTL_MS = 60000;
    service.campaignModel = {
      find: jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(campaigns) }),
      }),
    };
    service.inviteModel = { countDocuments: jest.fn().mockResolvedValue(3) };
    return service;
  };
  const queries = (service: any) =>
    service.inviteModel.countDocuments.mock.calls.map((c: any[]) => c[0]);

  it("awaitingReview counts submitted invites of this brand's existing campaigns only", async () => {
    const service = make([
      { _id: "camp-paid", campaignType: "paid_collab" },
      { _id: "camp-prod", campaignType: "product" },
    ]);
    const r = await service.getBrandAttentionCounts(BRAND);
    expect(r).toEqual({
      disputed: 3,
      overdue: 3,
      awaitingReview: 3,
      awaitingFulfillment: 3,
    });
    // Campaigns looked up by both id forms of the owner (brandId is Mixed).
    const owner = service.campaignModel.find.mock.calls[0][0].brandId.$in;
    expect(owner.map(String)).toEqual([BRAND, BRAND]);
    const [, , review, fulfil] = queries(service);
    expect(review).toEqual({
      brandId: BRAND,
      campaignId: { $in: ["camp-paid", "camp-paid", "camp-prod", "camp-prod"] },
      status: "submitted",
    });
    // Product shipping: product campaigns only (the 'pending' default is on every invite).
    expect(fulfil).toEqual({
      brandId: BRAND,
      campaignId: { $in: ["camp-prod", "camp-prod"] },
      status: "accepted",
      "productFulfillment.status": "pending",
    });
  });

  it("an invite whose campaign no longer exists is never counted (no campaigns → 0, no query)", async () => {
    const service = make([]);
    const r = await service.getBrandAttentionCounts(BRAND);
    expect(r.awaitingReview).toBe(0);
    expect(r.awaitingFulfillment).toBe(0);
    expect(queries(service)).toHaveLength(2); // only disputed + overdue
  });

  it("no product campaigns → awaitingFulfillment is 0 even with accepted invites", async () => {
    const service = make([{ _id: "camp-paid", campaignType: "paid_collab" }]);
    const r = await service.getBrandAttentionCounts(BRAND);
    expect(r.awaitingFulfillment).toBe(0);
    expect(queries(service)).toHaveLength(3);
  });
});
describe("findOneWithCampaign — who can read an invite", () => {
  const make = () => {
    const service: any = Object.create(CampaignInvitesService.prototype);
    const lean = (v: any) => ({ lean: () => Promise.resolve(v) });
    service.inviteModel = {
      findById: () =>
        lean({
          _id: "inv1",
          influencerId: "creator1",
          brandId: "host1",
          campaignId: "c1",
          status: "working",
        }),
    };
    service.campaignTransactionModel = {
      findOne: () => ({ select: () => ({ sort: () => lean(null) }) }),
    };
    service.campaignModel = {
      findById: () => ({ select: () => lean({ title: "Camp" }) }),
    };
    return service as CampaignInvitesService;
  };

  it.each([
    ["the invited creator", { id: "creator1", role: "influencer" }],
    ["the campaign owner (host)", { id: "host1", role: "brand" }],
    ["an admin", { id: "someone", role: "admin" }],
    ["a subadmin", { id: "someone", role: "subadmin" }],
  ])("%s can read it", async (_label, viewer) => {
    const res: any = await make().findOneWithCampaign("inv1", viewer);
    expect(res.invite._id).toBe("inv1");
    expect(res.campaign.title).toBe("Camp");
  });

  it.each([
    ["another creator", { id: "creator2", role: "influencer" }],
    ["another brand", { id: "host2", role: "brand" }],
    ["a viewer with no id", { id: "", role: "influencer" }],
  ])(
    "%s gets 'not found' (same as a missing invite)",
    async (_label, viewer) => {
      await expect(make().findOneWithCampaign("inv1", viewer)).rejects.toThrow(
        "Invite not found",
      );
    },
  );
});
