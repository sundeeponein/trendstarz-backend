import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsPayoutsService } from "./payments-payouts.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RazorpayService } from "../payment/razorpay.service";

describe("PaymentsPayoutsService", () => {
  let service: PaymentsPayoutsService;
  let campaignModel: any;
  let inviteModel: any;
  let transactionModel: any;
  let appSettingsModel: any;
  let brandModel: any;
  let influencerModel: any;
  let photographerModel: any;
  let razorpayService: any;

  beforeEach(async () => {
    const mockCampaignModel = {
      findById: jest.fn(),
    };

    const mockInviteModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
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

    const mockInfluencerModel = {
      findById: jest.fn(),
    };

    const mockPhotographerModel = {
      findById: jest.fn(),
    };

    const mockPushService = {
      sendToUser: jest.fn().mockResolvedValue(undefined),
    };

    const mockRazorpayService = {
      createOrder: jest.fn(),
      verifySignature: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      isPayoutsConfigured: jest.fn(),
      createPayoutByUpi: jest.fn(),
    };

    const mockNotificationsService = {
      createForUser: jest.fn().mockResolvedValue(undefined),
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
        { provide: getModelToken("Influencer"), useValue: mockInfluencerModel },
        {
          provide: getModelToken("Photographer"),
          useValue: mockPhotographerModel,
        },
        { provide: RazorpayService, useValue: mockRazorpayService },
        { provide: PushService, useValue: mockPushService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    service = module.get<PaymentsPayoutsService>(PaymentsPayoutsService);
    campaignModel = module.get(getModelToken("Campaign"));
    inviteModel = module.get(getModelToken("CampaignInvite"));
    transactionModel = module.get(getModelToken("CampaignTransaction"));
    appSettingsModel = module.get(getModelToken("AppSettings"));
    brandModel = module.get(getModelToken("Brand"));
    influencerModel = module.get(getModelToken("Influencer"));
    photographerModel = module.get(getModelToken("Photographer"));
    razorpayService = module.get(RazorpayService);

    appSettingsModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({}),
    });
    transactionModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    transactionModel.findOne.mockResolvedValue(null);
    const emptyUserLookup = {
      lean: jest.fn().mockResolvedValue(null),
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    };
    brandModel.findById.mockReturnValue(emptyUserLookup);
    influencerModel.findById.mockReturnValue(emptyUserLookup);
    photographerModel.findById.mockReturnValue(emptyUserLookup);
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
        inviteId: "inv1",
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findById.mockResolvedValue(tx);
      inviteModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            status: "completed",
            completedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
          }),
        }),
      });

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
      expect(inviteModel.findByIdAndUpdate).toHaveBeenCalledWith(
        "inv1",
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "approved",
            paidOutAt: tx.paidOutAt,
          }),
        }),
      );
    });

    it("rejects payout before 24h completion hold", async () => {
      const tx: any = {
        _id: "tx3",
        collectionStatus: "verified",
        payoutStatus: "pending",
        inviteId: "inv3",
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findById.mockResolvedValue(tx);
      inviteModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            status: "completed",
            completedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
          }),
        }),
      });

      await expect(
        service.markPayoutPaid("tx3", { payoutUtr: "PAYOUT123" }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.save).not.toHaveBeenCalled();
    });

    it("rejects payout when invite is not completed", async () => {
      const tx: any = {
        _id: "tx4",
        collectionStatus: "verified",
        payoutStatus: "pending",
        inviteId: "inv4",
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findById.mockResolvedValue(tx);
      inviteModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            status: "submitted",
            updatedAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
          }),
        }),
      });

      await expect(
        service.markPayoutPaid("tx4", { payoutUtr: "PAYOUT123" }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.save).not.toHaveBeenCalled();
    });
  });

  describe("runAutoPayoutSweep", () => {
    let originalAutoPayoutEnabled: boolean;

    beforeEach(() => {
      originalAutoPayoutEnabled = (PaymentsPayoutsService as any).AUTO_PAYOUT_ENABLED;
      (PaymentsPayoutsService as any).AUTO_PAYOUT_ENABLED = true;
      razorpayService.isPayoutsConfigured.mockReturnValue(true);
    });

    afterEach(() => {
      (PaymentsPayoutsService as any).AUTO_PAYOUT_ENABLED = originalAutoPayoutEnabled;
    });

    it("skips gateway payout until the admin-configured payout wait is satisfied", async () => {
      const tx: any = {
        _id: "tx_auto_wait",
        collectionStatus: "verified",
        payoutStatus: "pending",
        disputeStatus: "none",
        gateway: "razorpay",
        inviteId: "inv_auto_wait",
        recipientId: "inf_auto_wait",
        recipientRole: "influencer",
        recipientPayout: 100000,
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([tx]),
        }),
      });
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ payoutReleaseWaitHours: 4 }),
      });
      inviteModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            status: "completed",
            completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          }),
        }),
      });

      const result = await service.runAutoPayoutSweep("admin1");

      expect(result.skipped).toBe(1);
      expect(result.details?.[0]?.message).toContain("Payout lock active");
      expect(razorpayService.createPayoutByUpi).not.toHaveBeenCalled();
      expect(tx.save).not.toHaveBeenCalled();
    });

    it("creates gateway payout after the admin-configured payout wait is satisfied", async () => {
      const tx: any = {
        _id: "tx_auto_ready",
        collectionStatus: "verified",
        payoutStatus: "pending",
        disputeStatus: "none",
        gateway: "razorpay",
        inviteId: "inv_auto_ready",
        recipientId: "inf_auto_ready",
        recipientRole: "influencer",
        recipientPayout: 100000,
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([tx]),
        }),
      });
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ payoutReleaseWaitHours: 4 }),
      });
      inviteModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            status: "completed",
            completedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
          }),
        }),
      });
      influencerModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            name: "Creator",
            payout: { upiId: "creator@upi" },
          }),
        }),
      });
      razorpayService.createPayoutByUpi.mockResolvedValue({
        payoutId: "pout_auto_ready",
        status: "processed",
        utr: "UTR_AUTO_READY",
      });

      const result = await service.runAutoPayoutSweep("admin1");

      expect(result.processed).toBe(1);
      expect(razorpayService.createPayoutByUpi).toHaveBeenCalledWith(
        expect.objectContaining({
          amountPaise: 100000,
          recipientName: "Creator",
          recipientUpiId: "creator@upi",
        }),
      );
      expect(tx.payoutStatus).toBe("paid");
      expect(tx.payoutGatewayProvider).toBe("razorpayx");
      expect(tx.payoutUtr).toBe("UTR_AUTO_READY");
      expect(tx.save).toHaveBeenCalled();
      expect(inviteModel.findByIdAndUpdate).toHaveBeenCalledWith(
        "inv_auto_ready",
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "approved",
            paidOutAt: tx.paidOutAt,
          }),
        }),
      );
    });
  });

  describe("handleRazorpayXWebhook", () => {
    it("rejects webhook when signature is invalid", async () => {
      const razorpayService = moduleRefRazorpay(service);
      razorpayService.verifyWebhookSignature.mockReturnValue(false);

      await expect(
        service.handleRazorpayXWebhook(
          Buffer.from('{"event":"payout.processed"}', "utf8"),
          "bad_sig",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("marks payout as paid when webhook status is processed", async () => {
      const razorpayService = moduleRefRazorpay(service);
      razorpayService.verifyWebhookSignature.mockReturnValue(true);

      const tx: any = {
        _id: "tx_webhook_1",
        payoutTransferId: "pout_1",
        payoutStatus: "processing",
        payoutRetryCount: 2,
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findOne.mockResolvedValue(tx);

      const body = {
        event: "payout.processed",
        payload: {
          payout: {
            entity: {
              id: "pout_1",
              status: "processed",
              utr: "UTR_WEBHOOK_1",
            },
          },
        },
      };

      const result = await service.handleRazorpayXWebhook(
        Buffer.from(JSON.stringify(body), "utf8"),
        "good_sig",
      );

      expect(result.success).toBe(true);
      expect(tx.payoutStatus).toBe("paid");
      expect(tx.payoutTransferStatus).toBe("processed");
      expect(tx.payoutUtr).toBe("UTR_WEBHOOK_1");
      expect(tx.payoutRetryCount).toBe(0);
      expect(tx.paidOutAt).toBeInstanceOf(Date);
      expect(tx.payoutSettledAt).toBeInstanceOf(Date);
      expect(tx.save).toHaveBeenCalled();
    });

    it("increments retry and returns pending when webhook status is failed", async () => {
      const razorpayService = moduleRefRazorpay(service);
      razorpayService.verifyWebhookSignature.mockReturnValue(true);

      const tx: any = {
        _id: "tx_webhook_2",
        payoutTransferId: "pout_2",
        payoutStatus: "processing",
        payoutRetryCount: 1,
        save: jest.fn().mockResolvedValue(true),
      };
      transactionModel.findOne.mockResolvedValue(tx);

      const body = {
        event: "payout.failed",
        payload: {
          payout: {
            entity: {
              id: "pout_2",
              status: "failed",
              status_details: { description: "Beneficiary UPI declined" },
            },
          },
        },
      };

      const result = await service.handleRazorpayXWebhook(
        Buffer.from(JSON.stringify(body), "utf8"),
        "good_sig",
      );

      expect(result.success).toBe(true);
      expect(tx.payoutStatus).toBe("pending");
      expect(tx.payoutTransferStatus).toBe("failed");
      expect(tx.payoutFailureReason).toContain("Beneficiary UPI declined");
      expect(tx.payoutRetryCount).toBe(2);
      expect(tx.save).toHaveBeenCalled();
    });
  });
});

function moduleRefRazorpay(service: PaymentsPayoutsService): any {
  return (service as any).razorpayService;
}
