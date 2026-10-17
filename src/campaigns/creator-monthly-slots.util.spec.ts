import { Types } from "mongoose";
import {
  fullyBookedCreatorIds,
  planCycleStart,
  slotHoldingInviteMatch,
} from "./creator-monthly-slots.util";

/** Minimal in-memory evaluator for the match shapes the util builds. */
function matches(doc: any, cond: any): boolean {
  return Object.entries(cond).every(([key, want]: [string, any]) => {
    if (key === "$or") return want.some((c: any) => matches(doc, c));
    if (key === "$and") return want.every((c: any) => matches(doc, c));
    const val = key.split(".").reduce((o, k) => (o == null ? o : o[k]), doc);
    if (want === null) return val === null || val === undefined;
    if (want && typeof want === "object" && !(want instanceof Date)) {
      if ("$in" in want) return want.$in.some((w: any) => String(w) === String(val));
      if ("$gte" in want) return val != null && new Date(val) >= new Date(want.$gte);
    }
    return String(val) === String(want);
  });
}

describe("creator monthly slots", () => {
  const now = new Date("2026-10-12T10:00:00.000Z");
  const match = slotHoldingInviteMatch(now);
  const holds = (doc: any) => matches(doc, match);

  it("accepted and in-progress invites hold a slot", () => {
    for (const status of ["accepted", "payment_confirmed", "working", "submitted", "approved", "completed"]) {
      expect(holds({ status })).toBe(true);
    }
  });

  it("a pending invite holds a slot only until its due date", () => {
    expect(holds({ status: "pending", dueDate: new Date("2026-10-13") })).toBe(true);
    expect(holds({ status: "pending", dueDate: new Date("2026-10-11") })).toBe(false);
    expect(holds({ status: "pending", overdueFlaggedAt: new Date() })).toBe(false);
  });

  it("declined invites free the slot", () => {
    expect(holds({ status: "declined" })).toBe(false);
  });

  it("a no-show (accepted, never submitted) keeps the slot", () => {
    expect(holds({ status: "withdrawn", withdrawnReasonCode: "expired_unsubmitted" })).toBe(true);
  });

  it("a host-marked location no-show keeps the slot; an undelivered product frees it", () => {
    expect(holds({ status: "withdrawn", withdrawnReasonCode: "location_no_show" })).toBe(true);
    expect(holds({ status: "withdrawn", withdrawnReasonCode: "product_not_delivered" })).toBe(false);
  });

  it("a no-show closed before the reason code existed is recognised by its text", () => {
    expect(
      holds({
        status: "withdrawn",
        withdrawnReason: "Posting deadline and grace period expired with no submission.",
      }),
    ).toBe(true);
  });

  it("an admin-excused no-show frees the slot", () => {
    expect(
      holds({
        status: "withdrawn",
        withdrawnReasonCode: "expired_unsubmitted",
        missExcused: { at: new Date() },
      }),
    ).toBe(false);
  });

  it("host/admin withdrawals and refunds free the slot", () => {
    for (const code of ["owner", "admin_cancel", "dispute_refund", "auto_close", "expired_never_accepted"]) {
      expect(holds({ status: "withdrawn", withdrawnReasonCode: code })).toBe(false);
    }
    expect(holds({ status: "withdrawn", withdrawnReason: "Withdrawn by brand" })).toBe(false);
  });

  it("the plan month is anchored on signup, or premiumStart while premium", () => {
    expect(planCycleStart({ createdAt: new Date("2026-07-20T00:00:00Z") }, now).toISOString())
      .toBe("2026-09-20T00:00:00.000Z");
    expect(
      planCycleStart(
        {
          createdAt: new Date("2026-01-01T00:00:00Z"),
          isPremium: true,
          premiumStart: new Date("2026-10-05T00:00:00Z"),
        },
        now,
      ).toISOString(),
    ).toBe("2026-10-05T00:00:00.000Z");
  });

  it("fullyBookedCreatorIds flags only creators at their cap in their own month", async () => {
    const a = { _id: new Types.ObjectId(), createdAt: new Date("2026-07-20T00:00:00Z") }; // month from Sep 20
    const b = { _id: new Types.ObjectId(), createdAt: new Date("2026-07-20T00:00:00Z") };
    const c = { _id: new Types.ObjectId(), createdAt: new Date("2026-07-20T00:00:00Z"), isPremium: true };
    const inviteModel = {
      aggregate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { _id: a._id, dates: [new Date("2026-10-01")] }, // this month → full at cap 1
          { _id: b._id, dates: [new Date("2026-09-01")] }, // last month → free
          { _id: c._id, dates: [new Date("2026-10-01")] }, // premium cap 10 → free
        ]),
      }),
    };
    const full = await fullyBookedCreatorIds(
      inviteModel,
      [a, b, c],
      (x) => (x.isPremium ? 10 : 1),
      now,
    );
    expect([...full]).toEqual([String(a._id)]);
  });

  it("unlimited caps skip the query", async () => {
    const inviteModel = { aggregate: jest.fn() };
    const full = await fullyBookedCreatorIds(inviteModel, [{ _id: new Types.ObjectId() }], () => -1, now);
    expect(full.size).toBe(0);
    expect(inviteModel.aggregate).not.toHaveBeenCalled();
  });
});
