import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PlansService } from "./plans.service";

describe("PlansService", () => {
  let service: PlansService;
  let planModel: any;
  let subscriptionModel: any;
  let influencerModel: any;
  let brandModel: any;

  const VALID_USER_ID = "507f1f77bcf86cd799439011";
  const VALID_PLAN_ID = "507f1f77bcf86cd799439012";

  const mockPlan = {
    _id: VALID_PLAN_ID,
    name: "Star",
    code: "influencer-star",
    userType: "INFLUENCER",
    isActive: true,
    sortOrder: 1,
    price: { monthly: 499, quarterly: 1347, yearly: 4990 },
    features: [{ key: "contactVisibility", value: true }],
    limits: [{ key: "maxProfileImages", value: 5 }],
    policies: [{ key: "imageRetentionDays", value: 45 }],
    offers: [],
  };

  const mockSubscription = {
    _id: "507f1f77bcf86cd799439013",
    userId: VALID_USER_ID,
    userType: "INFLUENCER",
    planId: VALID_PLAN_ID,
    planName: "Star",
    status: "active",
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    featuresSnapshot: mockPlan.features,
    limitsSnapshot: mockPlan.limits,
    policiesSnapshot: mockPlan.policies,
  };

  beforeEach(async () => {
    const mockPlanModel: any = {
      find: jest.fn().mockReturnValue({
        sort: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue([mockPlan]) }),
      }),
      findById: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPlan) }),
      findOne: jest.fn().mockReturnValue({
        sort: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPlan) }),
      }),
      findByIdAndUpdate: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPlan) }),
      findByIdAndDelete: jest.fn().mockResolvedValue(mockPlan),
      create: jest
        .fn()
        .mockResolvedValue({ ...mockPlan, toObject: () => mockPlan }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      insertMany: jest.fn().mockResolvedValue([mockPlan]),
    };

    const mockSubscriptionModel: any = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockSubscription),
      }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([mockSubscription]),
        }),
      }),
      create: jest.fn().mockResolvedValue(mockSubscription),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findByIdAndUpdate: jest.fn().mockResolvedValue(mockSubscription),
    };

    const mockInfluencerModel = {
      exists: jest.fn().mockResolvedValue({ _id: "user1" }),
    };

    const mockBrandModel = {
      exists: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: getModelToken("Plan"), useValue: mockPlanModel },
        {
          provide: getModelToken("Subscription"),
          useValue: mockSubscriptionModel,
        },
        { provide: getModelToken("Influencer"), useValue: mockInfluencerModel },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
      ],
    }).compile();

    service = module.get<PlansService>(PlansService);
    planModel = module.get(getModelToken("Plan"));
    subscriptionModel = module.get(getModelToken("Subscription"));
    influencerModel = module.get(getModelToken("Influencer"));
    brandModel = module.get(getModelToken("Brand"));
  });

  describe("listAll", () => {
    it("should return all plans sorted by sortOrder", async () => {
      const result = await service.listAll();
      expect(result.success).toBe(true);
      expect(result.plans).toHaveLength(1);
      expect(planModel.find).toHaveBeenCalled();
    });
  });

  describe("getById", () => {
    it("should return plan by id", async () => {
      const result = await service.getById("plan1");
      expect(result.success).toBe(true);
      expect(result.plan.name).toBe("Star");
    });

    it("should throw NotFoundException for invalid id", async () => {
      planModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      await expect(service.getById("bad-id")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("create", () => {
    it("should create and normalize plan", async () => {
      const dto = {
        name: "Pro",
        userType: "INFLUENCER",
        price: { monthly: 999 },
      };
      const result = await service.create(dto);
      expect(result.success).toBe(true);
      expect(planModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ userType: "INFLUENCER" }),
      );
    });
  });

  describe("update", () => {
    it("should update existing plan", async () => {
      const result = await service.update("plan1", { name: "Star Plus" });
      expect(result.success).toBe(true);
      expect(planModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it("should throw NotFoundException if plan missing", async () => {
      planModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      await expect(service.update("bad-id", {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("remove", () => {
    it("should delete plan by id", async () => {
      const result = await service.remove("plan1");
      expect(result.success).toBe(true);
      expect(planModel.findByIdAndDelete).toHaveBeenCalledWith("plan1");
    });
  });

  describe("listActive", () => {
    it("should return active plans for user type", async () => {
      const result = await service.listActive("INFLUENCER");
      expect(result.success).toBe(true);
    });
  });

  describe("activateSubscription", () => {
    it("should expire existing subscriptions and create new one", async () => {
      const result = await service.activateSubscription(
        VALID_USER_ID,
        "Influencer",
        VALID_PLAN_ID,
        "1m",
      );
      expect(subscriptionModel.updateMany).toHaveBeenCalled();
      expect(subscriptionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: VALID_PLAN_ID,
          status: "active",
          billingCycle: "monthly",
        }),
      );
    });

    it("should throw if plan not found", async () => {
      planModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      await expect(
        service.activateSubscription("u1", "Influencer", "bad", "1m"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getActiveSubscription", () => {
    it("should return active subscription", async () => {
      const result = await service.getActiveSubscription(VALID_USER_ID);
      expect(result).toEqual(mockSubscription);
    });

    it("should return null if no active subscription", async () => {
      subscriptionModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      const result = await service.getActiveSubscription(VALID_USER_ID);
      expect(result).toBeNull();
    });
  });

  describe("getUserPlanCapabilities", () => {
    it("should return paid plan capabilities when subscribed", async () => {
      const result = await service.getUserPlanCapabilities(VALID_USER_ID);
      expect(result.hasPremium).toBe(true);
      expect(result.planName).toBe("Star");
      expect(result.features).toEqual(mockPlan.features);
    });

    it("should return free plan defaults when no subscription", async () => {
      subscriptionModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      const result = await service.getUserPlanCapabilities(VALID_USER_ID);
      expect(result.hasPremium).toBe(false);
      expect(result.planName).toBe("Free");
    });
  });

  describe("expireStaleSubscriptions", () => {
    it("should expire subscriptions past endDate", async () => {
      const result = await service.expireStaleSubscriptions();
      expect(subscriptionModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active" }),
        { status: "expired" },
      );
      expect(result).toBe(1);
    });
  });

  describe("findProPlanForUserType", () => {
    it("should find paid plan for user type", async () => {
      const result = await service.findProPlanForUserType("Influencer");
      expect(result.name).toBe("Star");
    });

    it("should throw if no active plan exists", async () => {
      planModel.findOne.mockReturnValue({
        sort: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });
      await expect(
        service.findProPlanForUserType("Influencer"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getUserSubscriptions", () => {
    it("should return all subscriptions for user", async () => {
      const result = await service.getUserSubscriptions(VALID_USER_ID);
      expect(result.success).toBe(true);
      expect(result.subscriptions).toHaveLength(1);
    });
  });
});
