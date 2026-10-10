import { FakeCollection } from "./fake-collection.fixture-spec";
import {
  REFUND_HOLD_DAYS,
  holdRefunds,
  isLegacyUnconfirmedRefund,
  markRefundsOwed,
  refundState,
  releaseToCreator,
  riskFlags,
} from "./campaign-refund.util";

const INVITE = "64b000000000000000000001";
const now = new Date("2026-10-10T10:00:00.000Z");

const paidRow = (over: Record<string, any> = {}) => ({
  _id: "tx1",
  inviteId: INVITE,
  transactionType: "paid_collab",
  collectionStatus: "verified",
  payoutStatus: "skipped",
  payerId: "host1",
  payerRole: "brand",
  recipientId: "creator1",
  agreedAmount: 50000,
  platformFee: 5000,
  payerTotal: 55000,
  ...over,
});

describe("campaign refunds", () => {
  describe("holdRefunds", () => {
    it("puts a verified paid-collab payment on a 7-day hold with an audit entry", async () => {
      const model = new FakeCollection([paidRow()]);
      const rows = await holdRefunds(
        model,
        INVITE,
        now,
        { byRole: "system" },
        "Deadline passed",
      );
      expect(rows).toHaveLength(1);
      const tx = model.get("tx1");
      expect(tx.refundStatus).toBe("on_hold");
      expect(new Date(tx.refundHoldUntil).getTime()).toBe(
        now.getTime() + REFUND_HOLD_DAYS * 24 * 60 * 60 * 1000,
      );
      expect(tx.refundHistory).toEqual([
        expect.objectContaining({
          action: "refund_on_hold",
          byRole: "system",
          note: "Deadline passed",
        }),
      ]);
    });

    it("skips unpaid collections, pay-to-join, paid-out and already-refunding rows", async () => {
      const model = new FakeCollection([
        paidRow({ _id: "a", collectionStatus: "proof_submitted" }),
        paidRow({ _id: "b", transactionType: "pay_to_join" }),
        paidRow({ _id: "c", payoutStatus: "paid" }),
        paidRow({ _id: "d", refundStatus: "sent" }),
        paidRow({ _id: "e", refundStatus: "owed" }),
      ]);
      const rows = await holdRefunds(
        model,
        INVITE,
        now,
        { byRole: "system" },
        "x",
      );
      expect(rows).toHaveLength(0);
      expect(model.docs.every((d) => d.refundStatus !== "on_hold")).toBe(true);
    });
  });

  it("markRefundsOwed (admin approval) skips the hold and records who and why", async () => {
    const model = new FakeCollection([paidRow({ refundStatus: "on_hold" })]);
    await markRefundsOwed(
      model,
      INVITE,
      now,
      { by: "admin1", byRole: "admin" },
      "Creator confirmed no post",
    );
    const tx = model.get("tx1");
    expect(tx.refundStatus).toBe("owed");
    expect(tx.refundOwedBy).toBe("admin1");
    expect(tx.refundOwedReason).toBe("Creator confirmed no post");
    expect(tx.refundHistory.at(-1)).toMatchObject({
      action: "refund_owed",
      by: "admin1",
    });
  });

  describe("releaseToCreator (delivery verified)", () => {
    it("cancels a refund that was on hold and queues the creator's payout", async () => {
      const model = new FakeCollection([
        paidRow({
          refundStatus: "on_hold",
          latePost: { status: "pending", url: "https://instagram.com/p/1" },
        }),
      ]);
      const res = await releaseToCreator(
        model,
        INVITE,
        now,
        { by: "admin1", byRole: "admin" },
        "Post verified",
      );
      expect(res.released).toHaveLength(1);
      expect(res.settlement).toHaveLength(0);
      const tx = model.get("tx1");
      expect(tx.refundStatus).toBe("cancelled");
      expect(tx.payoutStatus).toBe("processing");
      expect(tx.latePost.status).toBe("approved");
    });

    it("never reverses a refund that was already sent — opens a settlement instead", async () => {
      const model = new FakeCollection([
        paidRow({
          refundStatus: "sent",
          refundAmount: 55000,
          refundUtr: "UTR9",
        }),
      ]);
      const res = await releaseToCreator(
        model,
        INVITE,
        now,
        { by: "admin1", byRole: "admin" },
        "Found the post",
      );
      expect(res.released).toHaveLength(0);
      expect(res.settlement).toHaveLength(1);
      const tx = model.get("tx1");
      expect(tx.refundStatus).toBe("sent");
      expect(tx.payoutStatus).toBe("skipped");
      expect(tx.settlement).toMatchObject({
        status: "awaiting_host_repayment",
        amount: 55000,
      });
    });

    it("if the refund is marked sent at the same moment, the creator is NOT paid (settlement opens)", async () => {
      const model = new FakeCollection([paidRow({ refundStatus: "owed" })]);
      // Another admin marks the refund sent between our read and our guarded update.
      model.beforeFindOneAndUpdate = () => {
        const tx = model.get("tx1");
        if (tx.refundStatus === "owed") {
          tx.refundStatus = "sent";
          tx.refundAmount = 55000;
        }
      };
      const res = await releaseToCreator(
        model,
        INVITE,
        now,
        { by: "admin1", byRole: "admin" },
        "Late post ok",
      );
      expect(res.released).toHaveLength(0);
      expect(res.settlement).toHaveLength(1);
      const tx = model.get("tx1");
      expect(tx.payoutStatus).toBe("skipped");
      expect(tx.settlement.status).toBe("awaiting_host_repayment");
    });

    it("running it twice does not double-queue or reopen anything", async () => {
      const model = new FakeCollection([paidRow({ refundStatus: "on_hold" })]);
      await releaseToCreator(model, INVITE, now, { byRole: "admin" }, "ok");
      const second = await releaseToCreator(
        model,
        INVITE,
        now,
        { byRole: "admin" },
        "ok",
      );
      expect(second.settlement).toHaveLength(0);
      const tx = model.get("tx1");
      expect(tx.refundStatus).toBe("cancelled");
      expect(
        tx.refundHistory.filter((h: any) =>
          h.action.startsWith("refund_cancelled"),
        ),
      ).toHaveLength(1);
    });

    it("leaves pay-to-join rows alone", async () => {
      const model = new FakeCollection([
        paidRow({ transactionType: "pay_to_join", refundStatus: undefined }),
      ]);
      const res = await releaseToCreator(
        model,
        INVITE,
        now,
        { byRole: "admin" },
        "ok",
      );
      expect(res.released).toHaveLength(0);
      expect(model.get("tx1").payoutStatus).toBe("skipped");
    });
  });

  describe("legacy rows", () => {
    const legacy = paidRow({
      resolveOutcome: "refund_to_brand",
      refundStatus: undefined,
    });

    it("an old 'refund to brand' row is legacy-unconfirmed — neither owed nor sent", () => {
      expect(isLegacyUnconfirmedRefund(legacy)).toBe(true);
      expect(refundState(legacy)).toBe("legacy_unconfirmed");
    });

    it("is not legacy once a refund status is recorded, or when the host never paid", () => {
      expect(
        isLegacyUnconfirmedRefund({ ...legacy, refundStatus: "sent" }),
      ).toBe(false);
      expect(
        isLegacyUnconfirmedRefund({
          ...legacy,
          collectionStatus: "awaiting_payment",
        }),
      ).toBe(false);
      expect(
        isLegacyUnconfirmedRefund({
          ...legacy,
          transactionType: "pay_to_join",
        }),
      ).toBe(false);
    });
  });

  describe("riskFlags", () => {
    const row = (id: string, payer: string, recipient: string) => ({
      _id: id,
      payerId: payer,
      recipientId: recipient,
    });

    it("flags a repeat pair, a host with 2+ refunds and a creator with 2+ no-post closures", () => {
      const recent = [row("t1", "h1", "c1"), row("t2", "h1", "c1")];
      expect(riskFlags(recent[0], recent).sort()).toEqual(
        ["creator_repeat_no_post", "host_repeat_refunds", "repeat_pair"].sort(),
      );
    });

    it("a single refund raises no flag", () => {
      const recent = [row("t1", "h1", "c1"), row("t2", "h2", "c2")];
      expect(riskFlags(recent[0], recent)).toEqual([]);
    });
  });
});
