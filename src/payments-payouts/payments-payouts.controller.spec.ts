import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsPayoutsController } from "./payments-payouts.controller";
import { PaymentsPayoutsService } from "./payments-payouts.service";

describe("PaymentsPayoutsController", () => {
  let controller: PaymentsPayoutsController;
  let service: jest.Mocked<PaymentsPayoutsService>;

  beforeEach(async () => {
    const serviceMock: Partial<jest.Mocked<PaymentsPayoutsService>> = {
      calculatePayment: jest.fn(),
      submitPaymentProof: jest.fn(),
      listForAdmin: jest.fn(),
      getAdminSummary: jest.fn(),
      verifyCollection: jest.fn(),
      rejectCollection: jest.fn(),
      markPayoutPaid: jest.fn(),
      listMine: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsPayoutsController],
      providers: [
        {
          provide: PaymentsPayoutsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<PaymentsPayoutsController>(PaymentsPayoutsController);
    service = module.get(PaymentsPayoutsService);
  });

  it("calculate delegates campaignId and req.user.userId", async () => {
    service.calculatePayment.mockResolvedValue({ success: true } as any);

    const req = { user: { userId: "brand1" } };
    const result = await controller.calculate("camp1", req);

    expect(service.calculatePayment).toHaveBeenCalledWith("camp1", "brand1");
    expect(result).toEqual({ success: true });
  });

  it("submitProof delegates body and req.user.userId", async () => {
    service.submitPaymentProof.mockResolvedValue({ success: true } as any);

    const req = { user: { userId: "brand1" } };
    const body = { utrNumber: "UTR123", paymentProofUrl: "https://proof" };
    const result = await controller.submitProof("camp1", req, body);

    expect(service.submitPaymentProof).toHaveBeenCalledWith(
      "camp1",
      "brand1",
      body,
    );
    expect(result).toEqual({ success: true });
  });

  it("list passes query status", async () => {
    service.listForAdmin.mockResolvedValue({ success: true, data: [] } as any);

    const result = await controller.list("verified");

    expect(service.listForAdmin).toHaveBeenCalledWith("verified");
    expect(result).toEqual({ success: true, data: [] });
  });

  it("summary delegates to getAdminSummary", async () => {
    service.getAdminSummary.mockResolvedValue({ success: true } as any);

    const result = await controller.summary();

    expect(service.getAdminSummary).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("verify passes id and optional notes", async () => {
    service.verifyCollection.mockResolvedValue({ success: true } as any);

    const result = await controller.verify("tx1", { notes: "ok" });

    expect(service.verifyCollection).toHaveBeenCalledWith("tx1", "ok");
    expect(result).toEqual({ success: true });
  });

  it("reject passes id and reason", async () => {
    service.rejectCollection.mockResolvedValue({ success: true } as any);

    const result = await controller.reject("tx1", { reason: "invalid" });

    expect(service.rejectCollection).toHaveBeenCalledWith("tx1", "invalid");
    expect(result).toEqual({ success: true });
  });

  it("markPaid passes id and payout payload", async () => {
    service.markPayoutPaid.mockResolvedValue({ success: true } as any);

    const body = {
      payoutUtr: "PAYOUT123",
      payoutUpiId: "user@upi",
      payoutProofUrl: "https://proof",
      notes: "done",
    };
    const result = await controller.markPaid("tx1", body);

    expect(service.markPayoutPaid).toHaveBeenCalledWith("tx1", body);
    expect(result).toEqual({ success: true });
  });

  it("myHistory delegates req.user identifiers", async () => {
    service.listMine.mockResolvedValue({ success: true, data: [] } as any);

    const req = { user: { userId: "u1", role: "brand" } };
    const result = await controller.myHistory(req);

    expect(service.listMine).toHaveBeenCalledWith("u1", "brand");
    expect(result).toEqual({ success: true, data: [] });
  });
});
