jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));

import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { FakeCollection } from "./fake-collection.fixture-spec";
import { PaymentsPayoutsService } from "./payments-payouts.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PlatformEventsService } from "../platform-events/platform-events.service";
import { RazorpayService } from "../payment/razorpay.service";

const INVITE = "64b000000000000000000001";
const DAY = 24 * 60 * 60 * 1000;

const row = (over: Record<string, any> = {}) => ({
  _id: "tx1",
  campaignId: "64b0000000000000000000c1",
  inviteId: INVITE,
  transactionType: "paid_collab",
  collectionStatus: "verified",
  payoutStatus: "skipped",
  payerId: "host1",
  payerRole: "brand",
  recipientId: "creator1",
  recipientRole: "influencer",
  agreedAmount: 50000,
  platformFee: 5000,
  payerTotal: 55000,
  recipientPayout: 50000,
  ...over,
});

describe("Refund lifecycle (PaymentsPayoutsService)", () => {
  let service: PaymentsPayoutsService;
  let txs: FakeCollection;
  let invites: FakeCollection;
  let push: { sendToUser: jest.Mock };
  let notifications: { createForUser: jest.Mock };

  async function build(
    txRows: any[],
    inviteRows: any[] = [{ _id: INVITE, status: "withdrawn" }],
  ) {
    txs = new FakeCollection(txRows);
    invites = new FakeCollection(inviteRows);
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const empty = new FakeCollection([]);
    const module = await Test.createTestingModule({
      providers: [
        PaymentsPayoutsService,
        {
          provide: getModelToken("Campaign"),
          useValue: new FakeCollection([
            { _id: "64b0000000000000000000c1", title: "Diwali Reels" },
          ]),
        },
        { provide: getModelToken("CampaignInvite"), useValue: invites },
        { provide: getModelToken("CampaignTransaction"), useValue: txs },
        { provide: getModelToken("AppSettings"), useValue: empty },
        { provide: getModelToken("Brand"), useValue: empty },
        { provide: getModelToken("Influencer"), useValue: empty },
        { provide: getModelToken("Photographer"), useValue: empty },
        { provide: getModelToken("LinkConversion"), useValue: empty },
        {
          provide: RazorpayService,
          useValue: { isPayoutsConfigured: jest.fn() },
        },
        { provide: PushService, useValue: push },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: PlatformEventsService,
          useValue: { record: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();
    service = module.get(PaymentsPayoutsService);
  }

  describe("hold expiry (hourly job)", () => {
    const past = new Date(Date.now() - DAY);

    it("moves an expired hold to owed and records it", async () => {
      await build([row({ refundStatus: "on_hold", refundHoldUntil: past })]);
      const res = await service.expireRefundHolds();
      expect(res).toMatchObject({ moved: 1, waiting: 0 });
      expect(txs.get("tx1").refundStatus).toBe("owed");
      expect(txs.get("tx1").refundHistory.at(-1)).toMatchObject({
        action: "hold_expired_refund_owed",
        byRole: "system",
      });
    });

    it("keeps the hold while a late post waits for review", async () => {
      await build([
        row({
          refundStatus: "on_hold",
          refundHoldUntil: past,
          latePost: { status: "pending" },
        }),
      ]);
      const res = await service.expireRefundHolds();
      expect(res).toMatchObject({ moved: 0, waiting: 1 });
      expect(txs.get("tx1").refundStatus).toBe("on_hold");
    });

    it("keeps the hold while an off-platform / dispute report is unresolved", async () => {
      await build(
        [row({ refundStatus: "on_hold", refundHoldUntil: past })],
        [
          {
            _id: INVITE,
            status: "withdrawn",
            reportedIssue: { reportedAt: past, category: "offplatform" },
          },
        ],
      );
      await service.expireRefundHolds();
      expect(txs.get("tx1").refundStatus).toBe("on_hold");
    });

    it("does nothing before the 7 days are over", async () => {
      await build([
        row({
          refundStatus: "on_hold",
          refundHoldUntil: new Date(Date.now() + DAY),
        }),
      ]);
      expect(await service.expireRefundHolds()).toMatchObject({ moved: 0 });
    });
  });

  describe("mark refund sent", () => {
    it("records UTR, transfer date and amount, then tells the host", async () => {
      await build([row({ refundStatus: "owed" })]);
      const res = await service.markRefundSent("tx1", "admin1", {
        refundUtr: "UTR777",
        transferDate: "2026-10-09T08:00:00.000Z",
      });
      expect(res.success).toBe(true);
      const tx = txs.get("tx1");
      expect(tx).toMatchObject({
        refundStatus: "sent",
        refundUtr: "UTR777",
        refundAmount: 55000,
        refundSentBy: "admin1",
      });
      expect(new Date(tx.refundTransferDate).toISOString()).toBe(
        "2026-10-09T08:00:00.000Z",
      );
      expect(tx.refundHistory.at(-1)).toMatchObject({
        action: "refund_sent",
        utr: "UTR777",
        by: "admin1",
      });
      expect(notifications.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "host1",
          title: "Refund sent",
          body: expect.stringContaining("UTR777"),
        }),
      );
    });

    it.each([
      ["on hold", { refundStatus: "on_hold" }, "still on hold"],
      ["already sent", { refundStatus: "sent" }, "already marked as sent"],
      [
        "late post waiting",
        { refundStatus: "owed", latePost: { status: "pending" } },
        "late post is waiting",
      ],
    ])("refuses when %s", async (_label, over, message) => {
      await build([row(over)]);
      await expect(
        service.markRefundSent("tx1", "admin1", { refundUtr: "U1" }),
      ).rejects.toThrow(message);
      expect(txs.get("tx1").refundUtr).toBeUndefined();
    });

    it("refuses while the collaboration has an open report", async () => {
      await build(
        [row({ refundStatus: "owed" })],
        [
          {
            _id: INVITE,
            status: "withdrawn",
            reportedIssue: { reportedAt: new Date() },
          },
        ],
      );
      await expect(
        service.markRefundSent("tx1", "admin1", { refundUtr: "U1" }),
      ).rejects.toThrow("open report");
    });

    it("refuses more than the host paid", async () => {
      await build([row({ refundStatus: "owed" })]);
      await expect(
        service.markRefundSent("tx1", "admin1", {
          refundUtr: "U1",
          refundAmount: 60000,
        }),
      ).rejects.toThrow("can't be more");
    });

    it("loses cleanly if a late post was approved at the same moment (no double action)", async () => {
      await build([row({ refundStatus: "owed" })]);
      txs.beforeFindOneAndUpdate = () => {
        txs.get("tx1").refundStatus = "cancelled";
      };
      await expect(
        service.markRefundSent("tx1", "admin1", { refundUtr: "U1" }),
      ).rejects.toThrow("changed meanwhile");
      expect(txs.get("tx1").refundStatus).toBe("cancelled");
      expect(txs.get("tx1").refundUtr).toBeUndefined();
    });
  });

  describe("payouts never overlap a refund", () => {
    const completedInvite = {
      _id: INVITE,
      status: "completed",
      completedAt: new Date(Date.now() - 10 * DAY),
    };
    const withSave = () => {
      txs.findById.mockImplementation((id: any) => {
        const doc: any = { ...txs.get(id) };
        doc.save = jest.fn().mockResolvedValue(doc);
        return doc;
      });
    };

    it.each([
      [
        "refund owed",
        { payoutStatus: "processing", refundStatus: "owed" },
        "refund to the host",
      ],
      [
        "refund sent",
        { payoutStatus: "processing", refundStatus: "sent" },
        "refund to the host",
      ],
      [
        "settlement open",
        {
          payoutStatus: "processing",
          settlement: { status: "awaiting_host_repayment" },
        },
        "host's repayment",
      ],
      ["already paid", { payoutStatus: "paid" }, "already paid"],
    ])("blocks mark-paid when %s", async (_label, over, message) => {
      await build([row(over)], [completedInvite]);
      withSave();
      await expect(
        service.markPayoutPaid("tx1", { payoutUtr: "P1" }),
      ).rejects.toThrow(message);
    });

    it("a second concurrent mark-paid is rejected (atomic claim)", async () => {
      await build([row({ payoutStatus: "processing" })], [completedInvite]);
      withSave();
      txs.beforeFindOneAndUpdate = () => {
        txs.get("tx1").payoutStatus = "paid"; // the other admin won
      };
      await expect(
        service.markPayoutPaid("tx1", { payoutUtr: "P2" }),
      ).rejects.toThrow("changed meanwhile");
    });
  });

  describe("settlement", () => {
    const open = {
      refundStatus: "sent",
      refundAmount: 55000,
      settlement: { status: "awaiting_host_repayment", amount: 55000 },
    };

    it("host repayment closes it and queues the creator's payout", async () => {
      await build([row(open)]);
      await service.recordHostRepayment("tx1", "admin1", { utr: "HR1" });
      const tx = txs.get("tx1");
      expect(tx.settlement).toMatchObject({
        status: "repaid",
        hostRepaymentUtr: "HR1",
        hostRepaidAmount: 55000,
      });
      expect(tx.payoutStatus).toBe("processing");
      expect(tx.refundHistory.at(-1)).toMatchObject({
        action: "settlement_host_repaid",
      });
    });

    it("a partial repayment is refused", async () => {
      await build([row(open)]);
      await expect(
        service.recordHostRepayment("tx1", "admin1", {
          utr: "HR1",
          amount: 20000,
        }),
      ).rejects.toThrow("must repay");
      expect(txs.get("tx1").payoutStatus).toBe("skipped");
    });

    it("an exception needs a written reason and is recorded", async () => {
      await build([row(open)]);
      await expect(
        service.approveSettlementException("tx1", "admin1", { reason: "ok" }),
      ).rejects.toThrow("at least 10");
      await service.approveSettlementException("tx1", "admin1", {
        reason: "Host unreachable; paying creator in good faith",
      });
      expect(txs.get("tx1").settlement.status).toBe("exception_approved");
      expect(txs.get("tx1").refundHistory.at(-1)).toMatchObject({
        action: "settlement_exception_approved",
        by: "admin1",
      });
    });
  });

  describe("financial summary", () => {
    it("keeps on hold, owed, sent, legacy and settlement apart", async () => {
      await build([
        row({ _id: "h", refundStatus: "on_hold" }),
        row({ _id: "o", refundStatus: "owed" }),
        row({ _id: "s", refundStatus: "sent", refundAmount: 55000 }),
        row({ _id: "l", resolveOutcome: "refund_to_brand" }),
        row({
          _id: "st",
          refundStatus: "sent",
          refundAmount: 55000,
          settlement: { status: "awaiting_host_repayment", amount: 55000 },
        }),
      ]);
      const { data } = await service.getAdminSummary();
      expect(data).toMatchObject({
        refundOnHold: 55000,
        refundOnHoldCount: 1,
        refundDue: 55000,
        refundDueCount: 1,
        refunded: 110000,
        legacyUnconfirmed: 55000,
        legacyUnconfirmedCount: 1,
        settlementPending: 55000,
        settlementPendingCount: 1,
      });
    });
  });

  describe("admin refunds queue", () => {
    it("lists each state with flags and history; legacy rows carry no flags", async () => {
      await build([
        row({ _id: "a", refundStatus: "owed", createdAt: new Date() }),
        row({ _id: "b", refundStatus: "sent", createdAt: new Date() }),
        row({
          _id: "c",
          resolveOutcome: "refund_to_brand",
          payerId: "host9",
          recipientId: "creator9",
        }),
      ]);
      const { data } = await service.listRefunds();
      const byId = Object.fromEntries(data.map((d: any) => [d._id, d]));
      expect(byId.a.state).toBe("owed");
      expect(byId.a.flags).toEqual(
        expect.arrayContaining([
          "repeat_pair",
          "host_repeat_refunds",
          "creator_repeat_no_post",
        ]),
      );
      expect(byId.c.state).toBe("legacy_unconfirmed");
      expect(byId.c.flags).toEqual([]);
      const owedOnly = await service.listRefunds("owed");
      expect(owedOnly.data.map((d: any) => d._id)).toEqual(["a"]);
    });
  });
});
