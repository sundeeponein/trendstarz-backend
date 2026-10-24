import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CampaignsService } from "./campaigns.service";
import { PlansService } from "../plans/plans.service";
import { CloudinaryService } from "../cloudinary.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PlatformEventsService } from "../platform-events/platform-events.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";
import { CampaignInvitesService } from "./campaign-invites.service";

describe("CampaignsService", () => {
  let service: CampaignsService;
  let campaignModel: any;
  let campaignInviteModel: any;
  let brandModel: any;
  let plansService: any;
  let profileFlagModel: any;
  let platformEvents: { record: jest.Mock };

  const mockCampaign = {
    _id: "507f1f77bcf86cd799439011",
    brandId: "507f1f77bcf86cd799439012",
    title: "Test Campaign",
    status: "draft",
    minInfluencers: 1,
    maxInfluencers: 1,
    save: jest.fn(),
  };

  const mockBrand = {
    _id: "507f1f77bcf86cd799439012",
    brandName: "Test Brand",
    brandUsername: "testbrand",
    status: "accepted",
    isEmailVerified: true,
    isMobileVerified: true,
    verifiedByTrendStarz: true,
    verificationStatus: "approved",
    brandLogo: "https://example.com/logo.png",
    location: { state: "Karnataka", district: "Bengaluru" },
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-27T00:00:00.000Z"));

    const mockCampaignModel: any = jest
      .fn()
      .mockImplementation((data: any) => ({
        ...data,
        save: jest.fn().mockResolvedValue({ ...data, _id: "new-id" }),
      }));
    mockCampaignModel.find = jest.fn().mockReturnValue({
      sort: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([mockCampaign]) }),
    });
    mockCampaignModel.findById = jest.fn().mockResolvedValue(mockCampaign);
    mockCampaignModel.findOneAndDelete = jest
      .fn()
      .mockResolvedValue(mockCampaign);
    mockCampaignModel.countDocuments = jest.fn().mockResolvedValue(0);

    const mockBrandModel: any = jest.fn();
    mockBrandModel.findById = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(mockBrand),
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(mockBrand) }),
    });
    mockBrandModel.findOne = jest.fn().mockReturnValue({
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(mockBrand) }),
    });

    const mockInfluencerModel: any = jest.fn();
    mockInfluencerModel.findById = jest.fn();

    const mockPhotographerModel: any = jest.fn();
    mockPhotographerModel.findById = jest.fn();

    const mockAppSettingsModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({}),
        }),
      }),
    };

    const mockPlansService = {
      getUserPlanCapabilities: jest.fn().mockResolvedValue({
        hasPremium: false,
        limits: [{ key: "maxActiveCampaigns", value: 5 }],
      }),
    };

    const mockCampaignInviteModel: any = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      find: jest.fn(() => ({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      })),
    };

    const mockProfileFlagModel: any = {
      countDocuments: jest.fn().mockResolvedValue(0),
    };

    const mockCounterModel: any = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ seq: 1 }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getModelToken("Campaign"), useValue: mockCampaignModel },
        {
          provide: getModelToken("CampaignInvite"),
          useValue: mockCampaignInviteModel,
        },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
        { provide: getModelToken("Influencer"), useValue: mockInfluencerModel },
        {
          provide: getModelToken("Photographer"),
          useValue: mockPhotographerModel,
        },
        {
          provide: getModelToken("AppSettings"),
          useValue: mockAppSettingsModel,
        },
        {
          provide: getModelToken("ProfileFlag"),
          useValue: mockProfileFlagModel,
        },
        { provide: getModelToken("Counter"), useValue: mockCounterModel },
        {
          provide: getModelToken("DeletedCampaignSlot"),
          useValue: {
            countDocuments: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: PlansService, useValue: mockPlansService },
        { provide: CloudinaryService, useValue: {} },
        { provide: PushService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: PlatformEventsService,
          useValue: { record: jest.fn().mockResolvedValue(true) },
        },
        { provide: WhatsAppService, useValue: {} },
        {
          provide: ProfileVerificationService,
          useValue: {
            isProfileComplete: jest.fn().mockReturnValue(true),
            isAdminApproved: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: CampaignInvitesService,
          useValue: {
            expireUnsubmittedInvitesForCampaign: jest
              .fn()
              .mockResolvedValue(undefined),
            latestOpenPostingDeadline: jest.fn().mockResolvedValue(null),
            creatorsStillPosting: jest.fn().mockResolvedValue(false),
            hasPaymentRows: jest.fn().mockResolvedValue(false),
          },
        },
      ],
    }).compile();

    service = module.get<CampaignsService>(CampaignsService);
    campaignModel = module.get(getModelToken("Campaign"));
    campaignInviteModel = module.get(getModelToken("CampaignInvite"));
    brandModel = module.get(getModelToken("Brand"));
    profileFlagModel = module.get(getModelToken("ProfileFlag"));
    plansService = module.get(PlansService);
    platformEvents = module.get(PlatformEventsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("create", () => {
    it("should create a campaign within plan limits", async () => {
      const data = {
        title: "New Campaign",
        description: "Test",
        minInfluencers: 1,
        maxInfluencers: 1,
      };
      const result = await service.create(mockBrand._id, data);
      expect(result).toBeDefined();
      expect(result._id).toBe("new-id");
    });

    it("should throw when campaign limit exceeded", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      await expect(
        service.create(mockBrand._id, {
          title: "Over limit",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should allow unlimited campaigns when limit is -1", async () => {
      plansService.getUserPlanCapabilities.mockResolvedValue({
        limits: [{ key: "maxActiveCampaigns", value: -1 }],
      });
      campaignModel.countDocuments.mockResolvedValue(100);
      const result = await service.create(mockBrand._id, {
        title: "Unlimited",
        minInfluencers: 1,
        maxInfluencers: 1,
      });
      expect(result).toBeDefined();
    });

    it("should classify influencer to photographer requests as collaboration", async () => {
      const result = await service.create(
        mockBrand._id,
        {
          title: "Influencer collaboration",
          minInfluencers: 1,
          maxInfluencers: 1,
          inviteRecipientRole: "photographer",
        },
        "influencer",
      );

      expect(result).toBeDefined();
      expect(campaignModel).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerType: "brand",
          inviteRecipientRole: "photographer",
          requestKind: "photographer_collaboration",
        }),
      );
    });

    it("should allow a draft campaign that starts exactly 3 days from today", async () => {
      const result = await service.create(mockBrand._id, {
        title: "Three day start",
        description: "Valid campaign date window",
        status: "draft",
        timelineStart: "2026-06-30",
        timelineEnd: "2026-07-15",
        minInfluencers: 1,
        maxInfluencers: 1,
      });

      expect(result).toBeDefined();
      expect(campaignModel).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date("2026-06-30"),
          endDate: new Date("2026-07-15"),
          timelineStart: new Date("2026-06-30"),
          timelineEnd: new Date("2026-07-15"),
          acceptanceDeadline: new Date("2026-06-29T18:29:59.999Z") // 11:59:59 PM IST, the day before the start,
        }),
      );
    });

    it("should reject a campaign that starts before 3 days from today", async () => {
      await expect(
        service.create(mockBrand._id, {
          title: "Too soon",
          description: "Invalid campaign date window",
          status: "draft",
          timelineStart: "2026-06-29",
          timelineEnd: "2026-07-01",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow("Start date must be at least 3 days from today");
    });

    it("should reject a campaign duration over 15 days", async () => {
      await expect(
        service.create(mockBrand._id, {
          title: "Too long",
          description: "Invalid campaign date window",
          status: "draft",
          timelineStart: "2026-06-30",
          timelineEnd: "2026-07-16",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow("Campaign duration cannot exceed 15 days");
    });

    it("should block posting when the owner has an open profile photo safety flag", async () => {
      profileFlagModel.countDocuments.mockResolvedValueOnce(1);

      await expect(
        service.create(mockBrand._id, {
          title: "Unsafe owner photo",
          description: "Owner must resolve policy issue first",
          status: "active",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow(
        "Resolve profile photo policy issues before posting or sending campaign invitations.",
      );
    });
  });

  describe("findByBrandId", () => {
    it("should return campaigns sorted by createdAt desc", async () => {
      const result = await service.findByBrandId(mockBrand._id);
      expect(campaignModel.find).toHaveBeenCalledWith({
        brandId: mockBrand._id,
      });
      expect(result).toEqual([
        expect.objectContaining({
          ...mockCampaign,
          brand: expect.objectContaining({
            name: mockBrand.brandName,
            username: mockBrand.brandUsername,
          }),
        }),
      ]);
    });
  });

  describe("findById", () => {
    it("should return campaign by id", async () => {
      campaignModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockCampaign),
      });
      const result = await service.findById(mockCampaign._id);
      expect(result).toEqual(mockCampaign);
    });
  });

  describe("update", () => {
    it("should update campaign owned by brand", async () => {
      const campaign = {
        ...mockCampaign,
        save: jest
          .fn()
          .mockResolvedValue({ ...mockCampaign, title: "Updated" }),
      };
      campaignModel.findById.mockResolvedValue(campaign);
      const result = await service.update(mockCampaign._id, mockBrand._id, {
        title: "Updated",
      });
      expect(campaign.save).toHaveBeenCalled();
    });

    it("should throw NotFoundException if campaign not found", async () => {
      campaignModel.findById.mockResolvedValue(null);
      await expect(service.update("bad-id", mockBrand._id, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should enforce valid status transitions", async () => {
      const campaign = {
        ...mockCampaign,
        status: "completed",
        save: jest.fn(),
      };
      campaignModel.findById.mockResolvedValue(campaign);
      await expect(
        service.update(mockCampaign._id, mockBrand._id, { status: "draft" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("blocks a host from ending the campaign while a creator who accepted can still post", async () => {
      const campaign = { ...mockCampaign, status: "active", save: jest.fn() };
      campaignModel.findById.mockResolvedValue(campaign);
      const invites = (service as any).campaignInvitesService;
      invites.creatorsStillPosting.mockResolvedValueOnce(true);
      await expect(
        service.update(mockCampaign._id, mockBrand._id, {
          status: "completed",
        }),
      ).rejects.toThrow(
        /Creators who accepted are still within their posting window/,
      );
      expect(campaign.save).not.toHaveBeenCalled();
    });

    it("should allow draft -> active transition", async () => {
      const campaign = {
        ...mockCampaign,
        status: "draft",
        save: jest.fn().mockImplementation(function (this: any) {
          return this;
        }),
      };
      campaignModel.findById.mockResolvedValue(campaign);
      await service.update(mockCampaign._id, mockBrand._id, {
        status: "active",
      });
      expect(campaign.save).toHaveBeenCalled();
    });

    it("should block publishing a draft when the owner has an open profile photo safety flag", async () => {
      const campaign = {
        ...mockCampaign,
        status: "draft",
        save: jest.fn(),
      };
      campaignModel.findById.mockResolvedValue(campaign);
      profileFlagModel.countDocuments.mockResolvedValueOnce(1);

      await expect(
        service.update(mockCampaign._id, mockBrand._id, { status: "active" }),
      ).rejects.toThrow(
        "Resolve profile photo policy issues before posting or sending campaign invitations.",
      );
      expect(campaign.save).not.toHaveBeenCalled();
    });
  });

  describe("post-approval date change (once, before any acceptance)", () => {
    const approved = {
      ...mockCampaign,
      status: "active",
      startDate: new Date("2026-10-13T00:00:00.000Z"),
      endDate: new Date("2026-10-19T00:00:00.000Z"),
      datesChangedAt: null as Date | null,
    };
    const check = (campaign: any, normalized: any) =>
      (service as any).assertDateChangeAllowed(campaign, normalized);

    it("allows the first change while nobody has accepted, and reports it", async () => {
      campaignInviteModel.countDocuments = jest.fn().mockResolvedValue(0);
      await expect(
        check(approved, { startDate: new Date("2026-10-14T00:00:00.000Z") }),
      ).resolves.toBe(true);
    });

    it("blocks a second change", async () => {
      campaignInviteModel.countDocuments = jest.fn().mockResolvedValue(0);
      await expect(
        check(
          { ...approved, datesChangedAt: new Date() },
          { endDate: new Date("2026-10-20T00:00:00.000Z") },
        ),
      ).rejects.toThrow("can be changed only once");
    });

    it("blocks any change once a creator has accepted", async () => {
      campaignInviteModel.countDocuments = jest.fn().mockResolvedValue(1);
      await expect(
        check(approved, { endDate: new Date("2026-10-20T00:00:00.000Z") }),
      ).rejects.toThrow("after a creator has accepted");
    });

    it("re-sending the same dates is not a change", async () => {
      await expect(
        check(
          { ...approved, datesChangedAt: new Date() },
          { startDate: approved.startDate, endDate: approved.endDate },
        ),
      ).resolves.toBe(false);
    });

    it("dates stay freely editable before approval", async () => {
      await expect(
        check(
          { ...approved, status: "pending_review", datesChangedAt: new Date() },
          { startDate: new Date("2026-10-20T00:00:00.000Z") },
        ),
      ).resolves.toBe(false);
    });

    it("a client cannot reset the change marker", () => {
      const normalized = (service as any).normalizeCampaignPayload({
        datesChangedAt: null,
      });
      expect("datesChangedAt" in normalized).toBe(false);
    });
  });

  describe("monthly campaign slots", () => {
    const deletedSlots = () => (service as any).deletedCampaignSlotModel;

    it("a draft never needs a free slot", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      await expect(
        service.create(mockBrand._id, {
          title: "Draft",
          status: "draft",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).resolves.toBeDefined();
    });

    it("counts this month's campaigns in any status but draft/rejected — completed included", async () => {
      campaignModel.countDocuments.mockClear();
      await service.campaignSlotUsage(mockBrand._id);
      const filter = campaignModel.countDocuments.mock.calls[0][0];
      expect(filter.status).toEqual({ $nin: ["draft", "rejected"] });
      expect(JSON.stringify(filter.$or)).toContain("slotUsedAt");
    });

    it("a deleted campaign that went live still uses its slot", async () => {
      plansService.getUserPlanCapabilities.mockResolvedValue({
        limits: [{ key: "maxActiveCampaigns", value: 1 }],
      });
      campaignModel.countDocuments.mockResolvedValue(0);
      deletedSlots().countDocuments.mockResolvedValueOnce(1);
      await expect(
        service.create(mockBrand._id, {
          title: "Second",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow("campaign slot");
    });

    it("deleting a live campaign keeps its slot counted; deleting a draft doesn't", async () => {
      deletedSlots().create.mockClear();
      // "pending" = submitted for review: it already took a slot.
      campaignModel.findById.mockResolvedValue({
        ...mockCampaign,
        status: "pending",
        createdAt: new Date(),
      });
      await service.remove(mockCampaign._id, mockBrand._id);
      expect(deletedSlots().create).toHaveBeenCalledTimes(1);

      deletedSlots().create.mockClear();
      campaignModel.findById.mockResolvedValue({ ...mockCampaign, status: "draft" });
      await service.remove(mockCampaign._id, mockBrand._id);
      expect(deletedSlots().create).not.toHaveBeenCalled();
    });

    it("a barter campaign is refused once the month's barter share is used, even with total slots left", async () => {
      plansService.getUserPlanCapabilities.mockResolvedValue({
        limits: [
          { key: "maxActiveCampaigns", value: 3 },
          { key: "maxBarterCampaignsPerMonth", value: 2 },
        ],
      });
      // total used 2 of 3; barter used 2 of 2
      campaignModel.countDocuments.mockResolvedValue(2);
      await expect(
        service.create(mockBrand._id, {
          title: "Third barter",
          campaignType: "invite_location",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow("barter or location campaigns");
    });

    it("switching a submitted paid campaign to barter is refused when the barter share is used", async () => {
      plansService.getUserPlanCapabilities.mockResolvedValue({
        limits: [
          { key: "maxActiveCampaigns", value: 3 },
          { key: "maxBarterCampaignsPerMonth", value: 2 },
        ],
      });
      campaignModel.countDocuments.mockResolvedValue(2);
      const campaign = {
        ...mockCampaign,
        status: "pending_review",
        campaignType: "paid_collab",
        save: jest.fn(),
      };
      campaignModel.findById.mockResolvedValue(campaign);
      await expect(
        service.update(mockCampaign._id, mockBrand._id, { campaignType: "invite_location" }),
      ).rejects.toThrow("barter or location campaigns");
      expect(campaign.save).not.toHaveBeenCalled();
    });

    it("resubmitting a rejected campaign needs a free slot", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      const campaign = { ...mockCampaign, status: "rejected", save: jest.fn() };
      campaignModel.findById.mockResolvedValue(campaign);
      await expect(
        service.update(mockCampaign._id, mockBrand._id, { status: "pending_review" }),
      ).rejects.toThrow("campaign slot");
      expect(campaign.save).not.toHaveBeenCalled();
    });
  });

  describe("edit locks after approval", () => {
    const live = (over: any = {}) => ({
      ...mockCampaign,
      status: "active",
      campaignType: "product",
      productPaymentMode: "product_plus_payment",
      productPaymentAmount: 50000,
      ...over,
    });

    it("Product + Paid can't be switched to barter (or its cash changed) once approved — also while paused", async () => {
      for (const status of ["active", "pending"]) {
        campaignModel.findById.mockResolvedValueOnce(live({ status }));
        await expect(
          service.update(mockCampaign._id, mockBrand._id, { productPaymentMode: "product_only" } as any),
        ).rejects.toThrow('"productPaymentMode" cannot be changed');
      }
      campaignModel.findById.mockResolvedValueOnce(live());
      await expect(
        service.update(mockCampaign._id, mockBrand._id, { productPaymentAmount: 10000 } as any),
      ).rejects.toThrow('"productPaymentAmount" cannot be changed');
    });

    it("an older product campaign with no stored mode can still be edited (form sends product_only)", async () => {
      campaignInviteModel.countDocuments = jest.fn().mockResolvedValue(0);
      await expect(
        (service as any).assertEditableFields(
          live({ productPaymentMode: undefined, productPaymentAmount: undefined }),
          { productPaymentMode: "product_only" },
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("remove", () => {
    it("should delete campaign owned by brand", async () => {
      const result = await service.remove(mockCampaign._id, mockBrand._id);
      expect(campaignInviteModel.deleteMany).toHaveBeenCalled();
      expect(campaignModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: mockCampaign._id,
        status: mockCampaign.status,
      });
    });

    it("a second quick click deletes nothing more and records no second slot", async () => {
      campaignModel.findOneAndDelete.mockResolvedValueOnce(null); // the first click won
      campaignInviteModel.deleteMany.mockClear();
      await expect(service.remove(mockCampaign._id, mockBrand._id)).rejects.toThrow(
        "changed meanwhile",
      );
      expect(campaignInviteModel.deleteMany).not.toHaveBeenCalled();
    });

    it("refuses to delete a campaign with a payment started or made", async () => {
      const invites = (service as any).campaignInvitesService;
      invites.hasPaymentRows.mockResolvedValueOnce(true);
      campaignInviteModel.deleteMany.mockClear();
      await expect(
        service.remove(mockCampaign._id, mockBrand._id),
      ).rejects.toThrow("payment started or made");
      expect(campaignInviteModel.deleteMany).not.toHaveBeenCalled();
    });

    it("refuses once a creator accepted, or once the campaign is live (API, not just the button)", async () => {
      campaignInviteModel.deleteMany.mockClear();
      campaignInviteModel.find.mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{ status: "declined" }, { status: "accepted" }]),
        }),
      });
      await expect(service.remove(mockCampaign._id, mockBrand._id)).rejects.toThrow(
        "already accepted",
      );
      campaignModel.findById.mockResolvedValueOnce({ ...mockCampaign, status: "active" });
      await expect(service.remove(mockCampaign._id, mockBrand._id)).rejects.toThrow(
        "End or cancel it instead",
      );
      expect(campaignInviteModel.deleteMany).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException if campaign not found", async () => {
      campaignModel.findById.mockResolvedValue(null);
      await expect(service.remove("bad-id", mockBrand._id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("platform events", () => {
    const eventsOfType = (type: string) =>
      platformEvents.record.mock.calls
        .map((c) => c[0])
        .filter((e) => e.eventType === type);

    it("records campaign_created after the campaign is saved", async () => {
      await service.create(mockBrand._id, {
        title: "New Campaign",
        description: "Test",
        minInfluencers: 1,
        maxInfluencers: 1,
      });
      const [event] = eventsOfType("campaign_created");
      expect(event).toMatchObject({
        userId: mockBrand._id,
        userRole: "brand",
        brandId: mockBrand._id,
        campaignId: "new-id",
        dedupeKey: "campaign_created:new-id",
      });
      expect(event.platform).toBeUndefined();
    });

    it("records nothing when campaign creation is rejected", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      await expect(
        service.create(mockBrand._id, {
          title: "Over limit",
          minInfluencers: 1,
          maxInfluencers: 1,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(platformEvents.record).not.toHaveBeenCalled();
    });

    it("records campaign_completed when the host completes the campaign", async () => {
      const completedAt = new Date("2026-06-20T00:00:00Z");
      await service.handleStatusTransitionSideEffects("active", {
        _id: "c1",
        brandId: mockBrand._id,
        ownerType: "brand",
        status: "completed",
        completedBy: "host",
        completedAt,
      });
      const [event] = eventsOfType("campaign_completed");
      expect(event).toMatchObject({
        userId: mockBrand._id,
        userRole: "brand",
        campaignId: "c1",
        timestamp: completedAt,
        dedupeKey: "campaign_completed:c1",
        metadata: expect.objectContaining({ completedBy: "host" }),
      });
    });

    it("records no campaign_completed for other transitions", async () => {
      await service.handleStatusTransitionSideEffects("completed", {
        _id: "c1",
        status: "completed",
      });
      await service.handleStatusTransitionSideEffects("draft", {
        _id: "c1",
        status: "pending_review",
      });
      expect(eventsOfType("campaign_completed")).toHaveLength(0);
    });

    it("records campaign_completed as a system action when the cron auto-completes", async () => {
      const completedAt = new Date("2026-06-26T00:00:00Z");
      campaignModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([
              { _id: "c2", endDate: new Date("2026-06-01") },
            ]),
        }),
      });
      campaignInviteModel.findOne = jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });
      campaignModel.updateOne = jest
        .fn()
        .mockResolvedValue({ modifiedCount: 1 });
      campaignModel.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: "c2",
            brandId: mockBrand._id,
            completedBy: "auto",
            completedAt,
          }),
        }),
      });

      await service.autoCompleteExpiredCampaigns();

      expect(eventsOfType("campaign_completed")[0]).toMatchObject({
        userRole: "system",
        campaignId: "c2",
        timestamp: completedAt,
      });
    });

    it("records nothing when the cron's conditional update did not complete the campaign", async () => {
      campaignModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([
              { _id: "c2", endDate: new Date("2026-06-01") },
            ]),
        }),
      });
      campaignInviteModel.findOne = jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });
      campaignModel.updateOne = jest
        .fn()
        .mockResolvedValue({ modifiedCount: 0 });

      await service.autoCompleteExpiredCampaigns();
      expect(eventsOfType("campaign_completed")).toHaveLength(0);
    });
  });

  describe("auto-close waits for creators' own posting windows (CMP-24)", () => {
    let invites: any;
    const pastCampaign = () =>
      (campaignModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([
              { _id: "c24", endDate: new Date("2026-06-01T00:00:00Z") },
            ]),
        }),
      }));
    const findOneReturns = (...values: any[]) => {
      const fn = jest.fn();
      for (const v of values)
        fn.mockReturnValueOnce({
          select: jest
            .fn()
            .mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }),
        });
      campaignInviteModel.findOne = fn;
    };

    beforeEach(() => {
      invites = (service as any).campaignInvitesService;
      invites.expireUnsubmittedInvitesForCampaign.mockClear();
      campaignModel.updateOne = jest
        .fn()
        .mockResolvedValue({ modifiedCount: 0 });
    });

    it("past the campaign grace, but a creator's window is still open → no withdrawal, not completed", async () => {
      pastCampaign();
      findOneReturns({ _id: "inv-accepted" });
      invites.latestOpenPostingDeadline.mockResolvedValueOnce(
        new Date(Date.now() + 60 * 60 * 1000),
      );
      await service.autoCompleteExpiredCampaigns();
      expect(invites.latestOpenPostingDeadline).toHaveBeenCalledWith("c24");
      expect(
        invites.expireUnsubmittedInvitesForCampaign,
      ).not.toHaveBeenCalled();
      expect(campaignModel.updateOne).not.toHaveBeenCalled();
    });

    it("once every window has closed → existing close-out runs and the campaign completes", async () => {
      pastCampaign();
      // 1st findOne: active work exists; 2nd (after close-out): nothing still blocking.
      findOneReturns({ _id: "inv-accepted" }, null);
      invites.latestOpenPostingDeadline.mockResolvedValueOnce(
        new Date(Date.now() - 60 * 1000),
      );
      await service.autoCompleteExpiredCampaigns();
      expect(invites.expireUnsubmittedInvitesForCampaign).toHaveBeenCalledWith(
        "c24",
        "Campaign's grace period ended with no submission.",
      );
      expect(campaignModel.updateOne).toHaveBeenCalled();
    });

    it("no active work → the window check is skipped (behaviour unchanged)", async () => {
      pastCampaign();
      findOneReturns(null);
      invites.latestOpenPostingDeadline.mockClear();
      await service.autoCompleteExpiredCampaigns();
      expect(invites.latestOpenPostingDeadline).not.toHaveBeenCalled();
      expect(invites.expireUnsubmittedInvitesForCampaign).toHaveBeenCalled();
    });
  });
});
