import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CampaignsService } from "./campaigns.service";
import { PlansService } from "../plans/plans.service";
import { CloudinaryService } from "../cloudinary.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";

describe("CampaignsService", () => {
  let service: CampaignsService;
  let campaignModel: any;
  let campaignInviteModel: any;
  let brandModel: any;
  let plansService: any;

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
    mockCampaignModel.findByIdAndDelete = jest
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
        { provide: getModelToken("CampaignInvite"), useValue: mockCampaignInviteModel },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
        { provide: getModelToken("Influencer"), useValue: mockInfluencerModel },
        { provide: getModelToken("Photographer"), useValue: mockPhotographerModel },
        { provide: getModelToken("AppSettings"), useValue: mockAppSettingsModel },
        { provide: getModelToken("ProfileFlag"), useValue: mockProfileFlagModel },
        { provide: getModelToken("Counter"), useValue: mockCounterModel },
        { provide: PlansService, useValue: mockPlansService },
        { provide: CloudinaryService, useValue: {} },
        { provide: PushService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: ProfileVerificationService,
          useValue: {
            isProfileComplete: jest.fn().mockReturnValue(true),
            isAdminApproved: jest.fn().mockReturnValue(true),
          },
        },
      ],
    }).compile();

    service = module.get<CampaignsService>(CampaignsService);
    campaignModel = module.get(getModelToken("Campaign"));
    campaignInviteModel = module.get(getModelToken("CampaignInvite"));
    brandModel = module.get(getModelToken("Brand"));
    plansService = module.get(PlansService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("create", () => {
    it("should create a campaign within plan limits", async () => {
      const data = { title: "New Campaign", description: "Test", minInfluencers: 1, maxInfluencers: 1 };
      const result = await service.create(mockBrand._id, data);
      expect(result).toBeDefined();
      expect(result._id).toBe("new-id");
    });

    it("should throw when campaign limit exceeded", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      await expect(
        service.create(mockBrand._id, { title: "Over limit", minInfluencers: 1, maxInfluencers: 1 }),
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
          acceptanceDeadline: new Date("2026-06-29T23:59:59.999Z"),
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
  });

  describe("remove", () => {
    it("should delete campaign owned by brand", async () => {
      const result = await service.remove(mockCampaign._id, mockBrand._id);
      expect(campaignInviteModel.deleteMany).toHaveBeenCalled();
      expect(campaignModel.findByIdAndDelete).toHaveBeenCalledWith(
        mockCampaign._id,
      );
    });

    it("should throw NotFoundException if campaign not found", async () => {
      campaignModel.findById.mockResolvedValue(null);
      await expect(service.remove("bad-id", mockBrand._id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
