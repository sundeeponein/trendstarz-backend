import { FakeCollection } from "./fake-collection.fixture-spec";
import {
  consumeCredit,
  creditBalance,
  creditExpiry,
  creditStatement,
  expireCredit,
  issueCredit,
  restoreCreditUse,
  reverseIssuedCredit,
} from "./platform-credit.util";

const DAY = 24 * 60 * 60 * 1000;

describe("TrendStarZ credit ledger", () => {
  it("issues a 12-month lot and reports the balance", async () => {
    const m = new FakeCollection();
    const now = new Date("2026-11-01T00:00:00Z");
    await issueCredit(m, {
      ownerId: "host1",
      amount: 5000,
      reason: "fee",
      now,
    });
    expect(await creditBalance(m, "host1", now)).toBe(5000);
    expect(creditExpiry(now).toISOString()).toBe("2027-11-01T00:00:00.000Z");
    expect(m.docs[0]).toMatchObject({
      type: "issued",
      amount: 5000,
      remaining: 5000,
    });
  });

  it("spends the earliest-expiring credit first and records each use", async () => {
    const m = new FakeCollection([
      {
        _id: "late",
        ownerId: "host1",
        type: "issued",
        amount: 3000,
        remaining: 3000,
        expiresAt: new Date(Date.now() + 300 * DAY),
      },
      {
        _id: "early",
        ownerId: "host1",
        type: "issued",
        amount: 2000,
        remaining: 2000,
        expiresAt: new Date(Date.now() + 10 * DAY),
      },
    ]);
    const used = await consumeCredit(m, {
      ownerId: "host1",
      wanted: 2500,
      transactionId: "tx9",
    });
    expect(used).toBe(2500);
    expect(m.get("early").remaining).toBe(0);
    expect(m.get("late").remaining).toBe(2500);
    expect(
      m.docs.filter((d) => d.type === "used").map((d) => d.amount),
    ).toEqual([2000, 500]);
  });

  it("never spends more than exists, and never expired credit", async () => {
    const m = new FakeCollection([
      {
        _id: "old",
        ownerId: "host1",
        type: "issued",
        amount: 4000,
        remaining: 4000,
        expiresAt: new Date(Date.now() - DAY),
      },
      {
        _id: "ok",
        ownerId: "host1",
        type: "issued",
        amount: 1000,
        remaining: 1000,
        expiresAt: new Date(Date.now() + DAY),
      },
    ]);
    expect(
      await consumeCredit(m, {
        ownerId: "host1",
        wanted: 9000,
        transactionId: "t",
      }),
    ).toBe(1000);
    expect(m.get("old").remaining).toBe(4000);
  });

  it("two payments can't spend the same credit (guarded decrement)", async () => {
    const m = new FakeCollection([
      {
        _id: "lot",
        ownerId: "host1",
        type: "issued",
        amount: 1000,
        remaining: 1000,
        expiresAt: new Date(Date.now() + DAY),
      },
    ]);
    // The other payment spends the lot between our read and our update.
    m.beforeFindOneAndUpdate = () => {
      m.get("lot").remaining = 0;
      m.beforeFindOneAndUpdate = null;
    };
    expect(
      await consumeCredit(m, {
        ownerId: "host1",
        wanted: 1000,
        transactionId: "t2",
      }),
    ).toBe(0);
    expect(m.docs.filter((d) => d.type === "used")).toHaveLength(0);
  });

  it("a rejected payment gets its credit back once", async () => {
    const m = new FakeCollection([
      {
        _id: "lot",
        ownerId: "host1",
        type: "issued",
        amount: 1000,
        remaining: 1000,
        expiresAt: new Date(Date.now() + DAY),
      },
    ]);
    await consumeCredit(m, {
      ownerId: "host1",
      wanted: 600,
      transactionId: "tx1",
    });
    expect(await restoreCreditUse(m, "tx1")).toBe(600);
    expect(await restoreCreditUse(m, "tx1")).toBe(0);
    expect(m.get("lot").remaining).toBe(1000);
  });

  it("settlement reverses the unused part and reports what was already spent", async () => {
    const m = new FakeCollection();
    await issueCredit(m, {
      ownerId: "host1",
      amount: 5000,
      transactionId: "txR",
      reason: "fee",
    });
    await consumeCredit(m, {
      ownerId: "host1",
      wanted: 2000,
      transactionId: "txNew",
    });
    const res = await reverseIssuedCredit(m, "txR", "admin1", "post verified");
    expect(res).toEqual({ reversed: 3000, alreadyUsed: 2000 });
    expect(await creditBalance(m, "host1")).toBe(0);
  });

  it("expires unused credit after 12 months and keeps a statement", async () => {
    const m = new FakeCollection([
      {
        _id: "lot",
        ownerId: "host1",
        type: "issued",
        amount: 1500,
        remaining: 900,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);
    expect(await expireCredit(m)).toMatchObject({ expired: 900 });
    expect(await expireCredit(m)).toMatchObject({ expired: 0 });
    const st = await creditStatement(m, "host1");
    expect(st.balance).toBe(0);
    expect(st.entries.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(["issued", "expired"]),
    );
  });
});
