import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CampaignsService } from "./campaigns.service";
import { PlansService } from "../plans/plans.service";

describe("CampaignsService", () => {
  let service: CampaignsService;
  let campaignModel: any;
  let brandModel: any;
  let plansService: any;

  const mockCampaign = {
    _id: "507f1f77bcf86cd799439011",
    brandId: "507f1f77bcf86cd799439012",
    title: "Test Campaign",
    status: "draft",
    save: jest.fn(),
  };

  const mockBrand = {
    _id: "507f1f77bcf86cd799439012",
    brandName: "Test Brand",
    brandUsername: "testbrand",
  };

  beforeEach(async () => {
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

    const mockPlansService = {
      getUserPlanCapabilities: jest.fn().mockResolvedValue({
        hasPremium: false,
        limits: [{ key: "maxActiveCampaigns", value: 5 }],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getModelToken("Campaign"), useValue: mockCampaignModel },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
        { provide: PlansService, useValue: mockPlansService },
      ],
    }).compile();

    service = module.get<CampaignsService>(CampaignsService);
    campaignModel = module.get(getModelToken("Campaign"));
    brandModel = module.get(getModelToken("Brand"));
    plansService = module.get(PlansService);
  });

  describe("create", () => {
    it("should create a campaign within plan limits", async () => {
      const data = { title: "New Campaign", description: "Test" };
      const result = await service.create(mockBrand._id, data);
      expect(result).toBeDefined();
      expect(result._id).toBe("new-id");
    });

    it("should throw when campaign limit exceeded", async () => {
      campaignModel.countDocuments.mockResolvedValue(5);
      await expect(
        service.create(mockBrand._id, { title: "Over limit" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should allow unlimited campaigns when limit is -1", async () => {
      plansService.getUserPlanCapabilities.mockResolvedValue({
        limits: [{ key: "maxActiveCampaigns", value: -1 }],
      });
      campaignModel.countDocuments.mockResolvedValue(100);
      const result = await service.create(mockBrand._id, {
        title: "Unlimited",
      });
      expect(result).toBeDefined();
    });
  });

  describe("findByBrandId", () => {
    it("should return campaigns sorted by createdAt desc", async () => {
      const result = await service.findByBrandId(mockBrand._id);
      expect(campaignModel.find).toHaveBeenCalledWith({
        brandId: mockBrand._id,
      });
      expect(result).toEqual([mockCampaign]);
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
