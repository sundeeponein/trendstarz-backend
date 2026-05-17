import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { ReviewsService } from "./reviews.service";
import { PlansService } from "../plans/plans.service";

describe("ReviewsService", () => {
  let service: ReviewsService;
  let reviewModel: any;
  let inviteModel: any;
  let brandModel: any;
  let plansService: any;

  beforeEach(async () => {
    reviewModel = {
      findOne: jest.fn(),
      create: jest.fn(),
    };

    inviteModel = {
      findById: jest.fn(),
    };

    brandModel = {
      exists: jest.fn(),
    };

    plansService = {
      checkFeature: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getModelToken("Review"), useValue: reviewModel },
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: PlansService, useValue: plansService },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  it("maps influencer-written review targetType to brand when owner exists", async () => {
    plansService.checkFeature.mockResolvedValue(true);
    inviteModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "inv1",
        influencerId: "inf1",
        brandId: "brand1",
        campaignId: "camp1",
        status: "payment_confirmed",
      }),
    });
    reviewModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    brandModel.exists.mockResolvedValue(true);
    reviewModel.create.mockResolvedValue({ _id: "r1", targetType: "brand" });

    const result = await service.writeReview("inf1", "influencer", {
      inviteId: "inv1",
      rating: 5,
      comment: "Great campaign",
    });

    expect(reviewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerType: "influencer",
        targetId: "brand1",
        targetType: "brand",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("maps influencer-written review targetType to photographer when brand record is missing", async () => {
    plansService.checkFeature.mockResolvedValue(true);
    inviteModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "inv2",
        influencerId: "inf1",
        brandId: "photo1",
        campaignId: "camp2",
        status: "completed",
      }),
    });
    reviewModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    brandModel.exists.mockResolvedValue(false);
    reviewModel.create.mockResolvedValue({
      _id: "r2",
      targetType: "photographer",
    });

    await service.writeReview("inf1", "influencer", {
      inviteId: "inv2",
      rating: 4,
    });

    expect(reviewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerType: "influencer",
        targetId: "photo1",
        targetType: "photographer",
      }),
    );
  });

  it("allows photographer reviewer and targets influencer", async () => {
    plansService.checkFeature.mockResolvedValue(true);
    inviteModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "inv3",
        influencerId: "inf9",
        brandId: "photo9",
        campaignId: "camp3",
        status: "completed",
      }),
    });
    reviewModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    reviewModel.create.mockResolvedValue({ _id: "r3" });

    await service.writeReview("photo9", "photographer", {
      inviteId: "inv3",
      rating: 5,
      comment: "Excellent creator",
    });

    expect(reviewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerId: "photo9",
        reviewerType: "photographer",
        targetId: "inf9",
        targetType: "influencer",
      }),
    );
  });

  it("throws forbidden when canWriteReview feature is unavailable", async () => {
    plansService.checkFeature.mockResolvedValue(false);

    await expect(
      service.writeReview("u1", "influencer", {
        inviteId: "invX",
        rating: 5,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws when duplicate review exists", async () => {
    plansService.checkFeature.mockResolvedValue(true);
    inviteModel.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "inv4",
        influencerId: "inf4",
        brandId: "brand4",
        campaignId: "camp4",
        status: "completed",
      }),
    });
    reviewModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: "existing" }),
    });

    await expect(
      service.writeReview("brand4", "brand", {
        inviteId: "inv4",
        rating: 4,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
