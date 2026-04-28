import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsPayoutsService } from "./payments-payouts.service";

describe("PaymentsPayoutsService", () => {
  let service: PaymentsPayoutsService;
  let campaignModel: any;
  let inviteModel: any;
  let transactionModel: any;
  let appSettingsModel: any;

  beforeEach(async () => {
    const mockCampaignModel = {
      findById: jest.fn(),
    };

    const mockInviteModel = {
      find: jest.fn(),
    };

    const mockTransactionModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
    };

    const mockAppSettingsModel = {
      findOne: jest.fn(),
    };

    const mockBrandModel = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsPayoutsService,
        { provide: getModelToken("Campaign"), useValue: mockCampaignModel },
        { provide: getModelToken("CampaignInvite"), useValue: mockInviteModel },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: mockTransactionModel,
        },
        { provide: getModelToken("AppSettings"), useValue: mockAppSettingsModel },
        { provide: getModelToken("Brand"), useValue: mockBrandModel },
      ],
    }).compile();

    service = module.get<PaymentsPayoutsService>(PaymentsPayoutsService);
    campaignModel = module.get(getModelToken("Campaign"));
    inviteModel = module.get(getModelToken("CampaignInvite"));
    transactionModel = module.get(getModelToken("CampaignTransaction"));
    appSettingsModel = module.get(getModelToken("AppSettings"));
  });

  describe("calculatePayment", () => {
    it("computes paid_collab totals with fee enabled", async () => {
      campaignModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "camp1",
          brandId: "brand1",
          campaignType: "paid_collab",
          pricePerInfluencer: 10000,
        }),
      });
      inviteModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: "i1" }, { _id: "i2" }]),
      });
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          platformFeeEnabled: true,
          platformFeePercent: 10,
        }),
      });

      const result = await service.calculatePayment("camp1", "brand1");

      expect(result.acceptedCount).toBe(2);
      expect(result.agreedAmount).toBe(20000);
      expect(result.platformFee).toBe(2000);
      expect(result.payerTotal).toBe(22000);
      expect(result.recipientPayoutTotal).toBe(20000);
    });

    it("computes pay_to_join totals with fee deduction from recipient payout", async () => {
      campaignModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "camp2",
          brandId: "brand1",
          campaignType: "pay_to_join",
          pricePerInfluencer: 15000,
        }),
      });
      inviteModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: "i1" }]),
      });
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          platformFeeEnabled: true,
          platformFeePercent: 10,
        }),
      });

      const result = await service.calculatePayment("camp2", "brand1");

      expect(result.agreedAmount).toBe(15000);
      expect(result.platformFee).toBe(1500);
      expect(result.payerTotal).toBe(15000);
      expect(result.recipientPayoutTotal).toBe(13500);
    });
  });

  describe("submitPaymentProof", () => {
    it("throws when UTR is missing", async () => {
      await expect(
        service.submitPaymentProof("camp1", "brand1", { utrNumber: "" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates transactions for accepted invites", async () => {
      const campaign = {
        _id: "camp1",
        brandId: "brand1",
        campaignType: "paid_collab",
        pricePerInfluencer: 10000,
      };

      campaignModel.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(campaign),
      });

      inviteModel.find.mockImplementation((query: any) => {
        if (query?._id?.$in) {
          return {
            lean: jest
              .fn()
              .mockResolvedValue([
                { _id: "i1", influencerId: "inf1" },
                { _id: "i2", influencerId: "inf2" },
              ]),
          };
        }
        return {
          lean: jest.fn().mockResolvedValue([{ _id: "i1" }, { _id: "i2" }]),
        };
      });

      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          platformFeeEnabled: true,
          platformFeePercent: 10,
        }),
      });

      transactionModel.findOne.mockResolvedValue(null);
      transactionModel.create.mockImplementation(async (data: any) => data);

      const result = await service.submitPaymentProof("camp1", "brand1", {
        utrNumber: "UTR123",
        paymentProofUrl: "https://proof",
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(transactionModel.create).toHaveBeenCalledTimes(2);
      expect(transactionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionStatus: "proof_submitted",
          utrNumber: "UTR123",
        }),
      );
    });
  });

  describe("verifyCollection", () => {
    it("moves payout to processing when work already approved", async () => {
      const tx: any = {
        _id: "tx1",
        collectionStatus: "proof_submitted",
        workStatus: "approved",
        payoutStatus: "pending",
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findById.mockResolvedValue(tx);

      const result = await service.verifyCollection("tx1", "ok");

      expect(result.success).toBe(true);
      expect(tx.collectionStatus).toBe("verified");
      expect(tx.payoutStatus).toBe("processing");
      expect(tx.adminNotes).toBe("ok");
      expect(tx.save).toHaveBeenCalled();
    });

    it("throws when transaction does not exist", async () => {
      transactionModel.findById.mockResolvedValue(null);
      await expect(service.verifyCollection("bad-id")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("markPayoutPaid", () => {
    it("rejects mark-paid if collection not verified", async () => {
      transactionModel.findById.mockResolvedValue({
        _id: "tx1",
        collectionStatus: "proof_submitted",
      });

      await expect(
        service.markPayoutPaid("tx1", { payoutUtr: "PAYOUT123" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("marks payout as paid when collection is verified", async () => {
      const tx: any = {
        _id: "tx2",
        collectionStatus: "verified",
        payoutStatus: "pending",
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findById.mockResolvedValue(tx);

      const result = await service.markPayoutPaid("tx2", {
        payoutUtr: "PAYOUT123",
        payoutUpiId: "user@upi",
        payoutProofUrl: "https://payout-proof",
        notes: "done",
      });

      expect(result.success).toBe(true);
      expect(tx.payoutStatus).toBe("paid");
      expect(tx.payoutUtr).toBe("PAYOUT123");
      expect(tx.payoutUpiId).toBe("user@upi");
      expect(tx.payoutProofUrl).toBe("https://payout-proof");
      expect(tx.adminNotes).toBe("done");
      expect(tx.paidOutAt).toBeInstanceOf(Date);
      expect(tx.save).toHaveBeenCalled();
    });
  });
});
