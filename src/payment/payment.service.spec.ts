import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { PaymentService } from "./payment.service";
import { PlansService } from "../plans/plans.service";

describe("PaymentService", () => {
  let service: PaymentService;
  let paymentModel: any;
  let influencerModel: any;
  let brandModel: any;
  let plansService: any;

  const mockPayment = {
    _id: "pay1",
    userId: "user1",
    transactionId: "txn-123",
    amount: 499,
    premiumDuration: "1m",
    status: "pending",
    save: jest.fn(),
  };

  beforeEach(async () => {
    const mockPaymentModel: any = jest.fn().mockImplementation((data) => ({
      ...data,
      _id: "new-pay-id",
      save: jest.fn().mockResolvedValue({ ...data, _id: "new-pay-id" }),
    }));
    mockPaymentModel.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([mockPayment]),
        }),
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            populate: jest.fn().mockResolvedValue([mockPayment]),
          }),
        }),
      }),
    });
    mockPaymentModel.findById = jest
      .fn()
      .mockResolvedValue({ ...mockPayment, save: jest.fn() });
    mockPaymentModel.findOne = jest.fn().mockResolvedValue(null);
    mockPaymentModel.countDocuments = jest.fn().mockResolvedValue(1);

    const mockInfluencerModel = {
      findById: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "user1",
          name: "Test",
          email: "test@e.com",
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "user1" }),
    };

    const mockBrandModel = {
      findById: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      findByIdAndUpdate: jest.fn().mockResolvedValue(null),
    };

    const mockPlansService = {
      findProPlanForUserType: jest
        .fn()
        .mockResolvedValue({ _id: "plan1", name: "Pro" }),
      activateSubscription: jest.fn().mockResolvedValue({ _id: "sub1" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: getModelToken("Payment"), useValue: mockPaymentModel },
        { provide: getModelToken("Influencer"), useValue: mockInfluencerModel },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
        { provide: PlansService, useValue: mockPlansService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    paymentModel = module.get(getModelToken("Payment"));
    influencerModel = module.get(getModelToken("Influencer"));
    brandModel = module.get(getModelToken("Brand"));
    plansService = module.get(PlansService);
  });

  describe("getPaymentsByUser", () => {
    it("should return payments sorted by date with default limit", async () => {
      const result = await service.getPaymentsByUser("user1");
      expect(result.success).toBe(true);
      expect(result.payments).toEqual([mockPayment]);
    });

    it("should respect custom limit", async () => {
      await service.getPaymentsByUser("user1", 10);
      const sortReturn =
        paymentModel.find.mock.results[0].value.sort.mock.results[0].value;
      expect(sortReturn.limit).toHaveBeenCalledWith(10);
    });
  });

  describe("confirmUpgrade", () => {
    it("should activate premium for influencer", async () => {
      const result = await service.confirmUpgrade("user1", "1m");
      expect(result.success).toBe(true);
      expect(result.premiumEnd).toBeInstanceOf(Date);
      expect(influencerModel.findByIdAndUpdate).toHaveBeenCalledWith(
        "user1",
        expect.objectContaining({ isPremium: true, premiumDuration: "1m" }),
        { new: true },
      );
    });

    it("should fallback to brand if influencer not found", async () => {
      influencerModel.findByIdAndUpdate.mockResolvedValue(null);
      brandModel.findByIdAndUpdate.mockResolvedValue({ _id: "user1" });
      const result = await service.confirmUpgrade("user1", "3m");
      expect(result.success).toBe(true);
      expect(brandModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it("should return failure if neither model found", async () => {
      influencerModel.findByIdAndUpdate.mockResolvedValue(null);
      brandModel.findByIdAndUpdate.mockResolvedValue(null);
      const result = await service.confirmUpgrade("bad-id", "1m");
      expect(result.success).toBe(false);
    });

    it("should set correct end date for 1m duration", async () => {
      const before = new Date();
      const result = await service.confirmUpgrade("user1", "1m");
      const expected = new Date(before);
      expected.setMonth(expected.getMonth() + 1);
      expect(result.premiumEnd!.getMonth()).toBe(expected.getMonth());
    });

    it("should set correct end date for 1y duration", async () => {
      const before = new Date();
      const result = await service.confirmUpgrade("user1", "1y");
      const expected = new Date(before);
      expected.setFullYear(expected.getFullYear() + 1);
      expect(result.premiumEnd!.getFullYear()).toBe(expected.getFullYear());
    });
  });

  describe("createPendingPayment", () => {
    it("should create pending payment record", async () => {
      const result = await service.createPendingPayment(
        "user1",
        "txn-new",
        499,
        "1m",
      );
      expect(result.success).toBe(true);
      expect(result.paymentId).toBe("new-pay-id");
    });

    it("should reject duplicate transaction IDs", async () => {
      paymentModel.findOne.mockResolvedValue(mockPayment);
      const result = await service.createPendingPayment(
        "user1",
        "txn-123",
        499,
        "1m",
      );
      expect(result.success).toBe(false);
    });
  });

  describe("approvePayment", () => {
    it("should approve pending payment and activate premium", async () => {
      const payment = {
        ...mockPayment,
        status: "pending",
        save: jest.fn().mockResolvedValue(true),
      };
      paymentModel.findById.mockResolvedValue(payment);
      const result = await service.approvePayment("pay1", "admin1");
      expect(payment.status).toBe("approved");
      expect(payment.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("should reject if payment not found", async () => {
      paymentModel.findById.mockResolvedValue(null);
      const result = await service.approvePayment("bad-id", "admin1");
      expect(result.success).toBe(false);
    });

    it("should reject if payment not pending", async () => {
      paymentModel.findById.mockResolvedValue({
        ...mockPayment,
        status: "approved",
      });
      const result = await service.approvePayment("pay1", "admin1");
      expect(result.success).toBe(false);
    });
  });

  describe("rejectPayment", () => {
    it("should reject pending payment with reason", async () => {
      const payment = {
        ...mockPayment,
        status: "pending",
        save: jest.fn().mockResolvedValue(true),
      };
      paymentModel.findById.mockResolvedValue(payment);
      const result = await service.rejectPayment("pay1", "Invalid UTR");
      expect(payment.status).toBe("rejected");
      expect((payment as any).approvalNotes).toBe("Invalid UTR");
      expect(result.success).toBe(true);
    });

    it("should fail for non-pending payments", async () => {
      paymentModel.findById.mockResolvedValue({
        ...mockPayment,
        status: "approved",
      });
      const result = await service.rejectPayment("pay1", "reason");
      expect(result.success).toBe(false);
    });
  });

  describe("getPendingPayments", () => {
    it("should return paginated pending payments", async () => {
      const result = await service.getPendingPayments(1, 10);
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
    });
  });
});
