import { createHmac } from "crypto";
import { RazorpayWebhookService } from "./razorpay-webhook.service";

const event = (type: string, over: Record<string, any> = {}) => ({
  event: type,
  payload: {
    payment: { entity: { id: "pay_1", order_id: "order_1", amount: 49900, status: "captured", ...over } },
  },
});

describe("RazorpayWebhookService", () => {
  let paymentRow: any;
  let campaignRows: number;
  let monetization: any;
  let collab: any;
  let payouts: any;
  let service: RazorpayWebhookService;

  beforeEach(() => {
    paymentRow = null;
    campaignRows = 0;
    monetization = { completePaidOrder: jest.fn().mockResolvedValue({ success: true }) };
    collab = { completeReanalysisOrder: jest.fn().mockResolvedValue(true) };
    payouts = { completeCampaignOrder: jest.fn().mockResolvedValue({ success: true }) };
    const paymentModel = {
      findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(paymentRow) }) })),
    };
    const txModel = { countDocuments: jest.fn(() => Promise.resolve(campaignRows)) };
    service = new RazorpayWebhookService(paymentModel as any, txModel as any, monetization, collab, payouts);
  });

  it("accepts only Razorpay's signature over the exact bytes", () => {
    const raw = Buffer.from(JSON.stringify(event("payment.captured")));
    const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
    expect(RazorpayWebhookService.signatureValid(raw, sig, "whsec")).toBe(true);
    expect(RazorpayWebhookService.signatureValid(raw, sig, "other")).toBe(false);
    expect(RazorpayWebhookService.signatureValid(Buffer.from(raw.toString() + " "), sig, "whsec")).toBe(false);
    expect(RazorpayWebhookService.signatureValid(raw, sig, "")).toBe(false); // secret not configured
  });

  it("activates a Premium order the browser never confirmed", async () => {
    paymentRow = { purpose: "subscription", status: "pending", amountPaise: 49900 };
    await expect(service.handle(event("payment.captured"))).resolves.toMatchObject({ outcome: "completed" });
    expect(monetization.completePaidOrder).toHaveBeenCalledWith({ orderId: "order_1", paymentId: "pay_1", purpose: "subscription" });
  });

  it("does nothing more when the page already confirmed it", async () => {
    paymentRow = { purpose: "subscription", status: "approved", amountPaise: 49900 };
    await expect(service.handle(event("order.paid"))).resolves.toMatchObject({ outcome: "already_completed" });
    expect(monetization.completePaidOrder).not.toHaveBeenCalled();
  });

  it("refuses to activate when the paid amount differs from the order", async () => {
    paymentRow = { purpose: "subscription", status: "pending", amountPaise: 99900 };
    await expect(service.handle(event("payment.captured"))).resolves.toMatchObject({ outcome: "amount_mismatch" });
    expect(monetization.completePaidOrder).not.toHaveBeenCalled();
  });

  it("routes re-analysis and campaign orders to their own completion", async () => {
    paymentRow = { purpose: "collab_score_reanalysis", status: "pending", amountPaise: 49900 };
    await service.handle(event("payment.captured"));
    expect(collab.completeReanalysisOrder).toHaveBeenCalledWith({ orderId: "order_1", paymentId: "pay_1" });

    paymentRow = null;
    campaignRows = 2;
    await expect(service.handle(event("payment.captured"))).resolves.toMatchObject({ outcome: "completed" });
    expect(payouts.completeCampaignOrder).toHaveBeenCalledWith({ orderId: "order_1", paymentId: "pay_1", paidAmountPaise: 49900 });
  });

  it("ignores other events and non-captured payments", async () => {
    await expect(service.handle(event("payment.failed"))).resolves.toMatchObject({ outcome: "ignored" });
    await expect(service.handle(event("payment.captured", { status: "authorized" }))).resolves.toMatchObject({ outcome: "ignored" });
  });
});
