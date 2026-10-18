import { Types } from "mongoose";
import { runIntegrityChecks, REQUIRED_INDEXES } from "./integrity-checks";
import { DataIntegrityService, warningSignature } from "./data-integrity.service";
import { ACTIVE_INVITE_STATUSES } from "../campaigns/reinvite-rule.util";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("data integrity checks (real MongoDB)", () => {
  let tdb: TestDb;
  let db: any;
  const byKey = async () =>
    Object.fromEntries((await runIntegrityChecks(db)).map((c) => [c.key, c]));

  beforeAll(async () => {
    tdb = await startTestDb();
    db = tdb.conn.db;
  });
  afterAll(() => tdb.stop());
  beforeEach(async () => {
    for (const c of await db.listCollections().toArray()) await db.collection(c.name).drop();
    // A healthy database: the uniqueness indexes exist.
    await db.collection("campaigninvites").createIndex(
      { campaignId: 1, influencerId: 1 },
      { name: REQUIRED_INDEXES[0][1], unique: true, partialFilterExpression: { status: { $in: [...ACTIVE_INVITE_STATUSES] } } },
    );
    await db.collection("reviews").createIndex(
      { inviteId: 1, reviewerType: 1 },
      { name: REQUIRED_INDEXES[1][1], unique: true },
    );
  });

  it("reports every check ok on clean, production-shaped data", async () => {
    const camp = new Types.ObjectId().toHexString();
    const inv = new Types.ObjectId();
    await db.collection("campaigns").insertOne({ brandId: new Types.ObjectId().toHexString(), slotUsedAt: new Date(), pricePerInfluencer: 100000 });
    await db.collection("campaigninvites").insertOne({ _id: inv, campaignId: camp, brandId: new Types.ObjectId().toHexString(), influencerId: new Types.ObjectId(), status: "accepted", unlocked: true, unlockType: "paid_collab_payment" });
    await db.collection("campaigntransactions").insertOne({ transactionType: "paid_collab", campaignId: camp, inviteId: inv, payerId: new Types.ObjectId().toHexString(), recipientId: new Types.ObjectId().toHexString(), agreedAmount: 100000, payerTotal: 100000, recipientPayout: 100000, collectionStatus: "verified", payoutStatus: "paid" });
    await db.collection("campaigninvites").updateOne({ _id: inv }, { $set: { status: "approved", paidOutAt: new Date() } });
    const premiumUser = new Types.ObjectId();
    await db.collection("brands").insertOne({ _id: premiumUser, email: "p@x.com", isPremium: true, premiumSource: "admin", premiumEnd: new Date(Date.now() + 86400000) });
    await db.collection("subscriptions").insertOne({ userId: premiumUser, userType: "BRAND", status: "active", endDate: new Date(Date.now() + 86400000) });
    await db.collection("payments").insertOne({ amount: 499, amountPaise: 49900, status: "approved" });
    await db.collection("influencers").insertOne({ email: "a@x.com", isPremium: true, premiumSource: "admin" });
    await db.collection("brands").insertOne({ email: "b@x.com" });

    const checks = await runIntegrityChecks(db);
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
    expect(checks).toHaveLength(12);
  });

  it("flags each kind of problem in its own check", async () => {
    await db.collection("reviews").dropIndex(REQUIRED_INDEXES[1][1]);
    const camp = new Types.ObjectId().toHexString();
    const inf = new Types.ObjectId();
    const host = new Types.ObjectId().toHexString();
    const t = new Date("2026-10-01T10:00:00Z");
    await db.collection("campaigns").insertMany([
      { brandId: host, slotUsedAt: t, campaignNumber: 1 },
      { brandId: host, slotUsedAt: new Date(t.getTime() + 1200), campaignNumber: 2 },
      { brandId: "some_username" }, // not an id
    ]);
    await db.collection("campaigninvites").insertMany([
      // Same creator twice, hidden from the index by the id type difference.
      { campaignId: camp, influencerId: inf, brandId: host, status: "pending" },
      { campaignId: new Types.ObjectId(camp), influencerId: inf, brandId: host, status: "accepted" },
      { campaignId: camp, influencerId: new Types.ObjectId(), brandId: host, status: "completed", unlocked: true, unlockType: "paid_collab_payment" },
    ]);
    await db.collection("campaigntransactions").insertOne({ campaignId: camp, inviteId: new Types.ObjectId(), payerId: host, recipientId: host, payerTotal: -1 });
    await db.collection("payments").insertOne({ amount: 499 });
    const premium = await db.collection("influencers").insertOne({ email: "free@x.com", isPremium: true });
    await db.collection("brands").insertOne({ email: "FREE@x.com " });

    const c = await byKey();
    expect(c.id_types.status).toBe("warn"); // ObjectId campaignId + username brandId
    expect(c.unique_indexes.samples).toEqual(["reviews.uniq_review_per_invite_side"]);
    expect(c.duplicate_active_invites.count).toBe(1);
    expect(c.negative_money.samples).toEqual(["campaigntransactions.payerTotal: 1"]);
    expect(c.payments_amount_paise.count).toBe(1);
    expect(c.slot_race_pairs.count).toBe(1);
    expect(c.unexplained_premium.samples[0]).toContain(String(premium.insertedId));
    expect(c.unpaid_unlocks.count).toBe(1);
    expect(c.shared_emails.samples[0]).toContain("free@x.com");
  });

  it("catches Premium removed from a profile while its subscription stays active, and invite/payment drift", async () => {
    const alice = new Types.ObjectId();
    await db.collection("influencers").insertOne({ _id: alice, email: "alice@x.com", isPremium: false });
    await db.collection("subscriptions").insertOne({ userId: alice, userType: "INFLUENCER", status: "active", endDate: new Date(Date.now() + 86400000) });
    const inv = new Types.ObjectId();
    await db.collection("campaigninvites").insertOne({ _id: inv, campaignId: "c", brandId: "b", influencerId: new Types.ObjectId(), status: "approved" });
    await db.collection("campaigntransactions").insertOne({ transactionType: "paid_collab", inviteId: inv, payoutStatus: "paid", collectionStatus: "verified" });

    const c = await byKey();
    expect(c.premium_sources_agree.count).toBe(1);
    expect(c.premium_sources_agree.samples[0]).toContain("alice@x.com");
    expect(c.invite_payment_agree.samples[0]).toContain("no payout time");

    // Bonus months lost on the profile: profile ends a month before the subscription.
    const bob = new Types.ObjectId();
    const soon = new Date(Date.now() + 5 * 86400000);
    await db.collection("brands").insertOne({ _id: bob, email: "bob@x.com", isPremium: true, premiumSource: "payment", premiumEnd: soon });
    await db.collection("subscriptions").insertOne({ userId: bob, userType: "BRAND", status: "active", endDate: new Date(soon.getTime() + 30 * 86400000) });
    const again = await byKey();
    expect(again.premium_sources_agree.count).toBe(2);
    expect(again.premium_sources_agree.samples.join(" ")).toContain("bob@x.com");
  });

  it("checks that payment amounts add up", async () => {
    const inv = new Types.ObjectId();
    await db.collection("campaigninvites").insertOne({ _id: inv, campaignId: "c", brandId: "b", influencerId: new Types.ObjectId(), status: "approved", agreedAmount: 1000, agreedAmountPaise: 100000 });
    await db.collection("campaigntransactions").insertMany([
      // right: 100000 + 5000 + 900 − 0 = 105900; payout 100000 − 2000
      { transactionType: "paid_collab", inviteId: inv, agreedAmount: 100000, platformFee: 5000, gstAmount: 900, payerTotal: 105900, recipientFee: 2000, recipientPayout: 98000 },
      // wrong total, and amount differs from the invite
      { transactionType: "paid_collab", inviteId: inv, agreedAmount: 90000, platformFee: 5000, gstAmount: 900, payerTotal: 100000, recipientFee: 0, recipientPayout: 90000 },
      // compensation rows are skipped
      { transactionType: "paid_collab", inviteId: inv, agreedAmount: 100000, payerTotal: 1, recipientPayout: 20000, compensation: { amount: 20000 } },
      // platform fee with credit
      { transactionType: "platform_fee", platformFee: 10000, gstAmount: 1800, creditApplied: 3000, payerTotal: 8800, recipientPayout: 0 },
    ]);
    const c = (await byKey()).money_adds_up;
    expect(c.count).toBe(2);
    expect(c.samples.join(" ")).toContain("payer total 100000 ≠ 95900");
    expect(c.samples.join(" ")).toContain("≠ invite's agreed 100000");
  });

  it("an admin can explain a flagged record: it stops counting, the record is untouched", async () => {
    const inv = new Types.ObjectId();
    await db.collection("campaigninvites").insertOne({
      _id: inv, campaignId: new Types.ObjectId().toHexString(), brandId: new Types.ObjectId().toHexString(),
      influencerId: new Types.ObjectId(), status: "completed", unlocked: true, unlockType: "paid_collab_payment",
    });
    const service = new DataIntegrityService(tdb.conn as any);
    await service.onModuleInit();

    await expect(
      service.explain({ check: "unpaid_unlocks", ref: String(inv), reason: "ok" }, "admin1"),
    ).rejects.toThrow(/at least 10/);
    await expect(
      service.explain({ check: "negative_money", ref: String(inv), reason: "settled outside the app" }, "admin1"),
    ).rejects.toThrow(/can't be explained/);
    await expect(
      service.explain({ check: "unpaid_unlocks", ref: new Types.ObjectId().toHexString(), reason: "settled outside the app" }, "admin1"),
    ).rejects.toThrow(/isn't flagged/);

    const run = await service.explain(
      { check: "unpaid_unlocks", ref: String(inv), reason: "Paid outside the app during early testing, June 2026" },
      "admin1",
    );
    const c = run.checks.find((x) => x.key === "unpaid_unlocks")!;
    expect(c).toMatchObject({ status: "ok", count: 0, explained: 1 });
    expect((await db.collection("campaigninvites").findOne({ _id: inv })).unlocked).toBe(true);
    const [note] = await service.explanations();
    expect(note).toMatchObject({ check: "unpaid_unlocks", ref: String(inv), by: "admin1" });
  });

  it("the alert fingerprint changes only when what's wrong changes", () => {
    const warn = (key: string, count: number) => ({ key, label: key, status: "warn" as const, count, help: "", samples: [] });
    const ok = { key: "x", label: "x", status: "ok" as const, count: 0, help: "", samples: [] };
    expect(warningSignature([warn("a", 1), ok])).toBe(warningSignature([ok, warn("a", 1)]));
    expect(warningSignature([warn("a", 1)])).not.toBe(warningSignature([warn("a", 2)]));
  });
});
