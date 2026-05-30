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
import { sendAppEmail } from "../utils/app-email.service";

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
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        {
          provide: getModelToken("CampaignSubmission"),
          useValue: submissionModel,
        },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: getModelToken("Photographer"), useValue: photographerModel },
        { provide: getModelToken("Influencer"), useValue: influencerModel },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: txnModel,
        },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
    (sendAppEmail as jest.Mock).mockClear();
  });

  describe("adminCountOpenDisputes", () => {
    it("counts disputed invites with unresolved reportedIssue", async () => {
      inviteModel.countDocuments.mockResolvedValue(7);
      const result = await service.adminCountOpenDisputes();
      expect(inviteModel.countDocuments).toHaveBeenCalledWith({
        status: "disputed",
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
        mockChainSelectLean({ brandUsername: "brand1" }),
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
        .mockReturnValueOnce(mockChainSelectLean({ brandUsername: "brand1" })) // assertBrandOwnsInvite no-op (skipped because brandId matches)
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

    brandModel = jest.fn();
    brandModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ brandUsername: "brand1" }),
      }),
    });

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ email: "inf@test.com", name: "Inf" }),
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
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: {} },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: getModelToken("Photographer"), useValue: jest.fn() },
        { provide: getModelToken("Influencer"), useValue: influencerModel },
        { provide: getModelToken("CampaignTransaction"), useValue: {} },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
  });

  function mockCampaignLean(overrides: any = {}) {
    const data = {
      _id: "camp1",
      brandId: "brand1",
      title: "Test Campaign",
      ...overrides,
    };
    // create() calls campaignModel.findById(id).lean()
    campaignModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(data),
    });
  }

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

  it("throws when total invited >= maxInfluencers cap", async () => {
    mockCampaignLean({ maxInfluencers: 2 });
    inviteModel.countDocuments.mockResolvedValue(2); // 2 already invited
    await expect(
      service.create("brand1", { campaignId: "camp1", influencerId: "inf1" }),
    ).rejects.toThrow(BadRequestException);
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
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: {} },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: getModelToken("Photographer"), useValue: jest.fn() },
        { provide: getModelToken("Influencer"), useValue: influencerModel },
        { provide: getModelToken("CampaignTransaction"), useValue: {} },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
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
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });

    campaignTransactionModel = { updateMany: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: submissionModel },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: getModelToken("Photographer"), useValue: jest.fn() },
        { provide: getModelToken("Influencer"), useValue: influencerModel },
        { provide: getModelToken("CampaignTransaction"), useValue: campaignTransactionModel },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
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
        campaignMode: "invite_only",
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: {} },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: jest.fn() },
        { provide: getModelToken("Photographer"), useValue: jest.fn() },
        { provide: getModelToken("Influencer"), useValue: jest.fn() },
        { provide: getModelToken("CampaignTransaction"), useValue: {} },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
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
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: {} },
        { provide: getModelToken("Campaign"), useValue: {} },
        { provide: getModelToken("Brand"), useValue: jest.fn() },
        { provide: getModelToken("Photographer"), useValue: photographerModel },
        { provide: getModelToken("Influencer"), useValue: jest.fn() },
        { provide: getModelToken("CampaignTransaction"), useValue: {} },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
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
              campaignId: { _id: "camp-1", brandId: "brand-1" },
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
              campaignId: { _id: "camp-1", brandId: "brand-1" },
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
          lean: jest.fn().mockResolvedValue({ campaignType: "paid_collab" }),
        }),
      }),
    };

    plansService = {
      getUserPlanCapabilities: jest.fn().mockResolvedValue({ hasPremium: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("CampaignSubmission"), useValue: {} },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: { findById: jest.fn() } },
        { provide: getModelToken("Photographer"), useValue: {} },
        { provide: getModelToken("Influencer"), useValue: {} },
        { provide: getModelToken("CampaignTransaction"), useValue: {} },
        { provide: PlansService, useValue: plansService },
        { provide: PushService, useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationsService, useValue: { createForUser: jest.fn().mockResolvedValue(undefined) } },
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
