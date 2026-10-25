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
    await db.collection("campaignsubmissions").createIndex(
      { inviteId: 1 },
      { name: REQUIRED_INDEXES[2][1], unique: true },
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
    await db.collection("brands").insertOne({ _id: premiumUser, email: "p@x.com", publicId: "BRD100001", isPremium: true, premiumSource: "admin", premiumEnd: new Date(Date.now() + 86400000) });
    await db.collection("subscriptions").insertOne({ userId: premiumUser, userType: "BRAND", status: "active", endDate: new Date(Date.now() + 86400000) });
    await db.collection("payments").insertOne({ amount: 499, amountPaise: 49900, status: "approved" });
    await db.collection("influencers").insertOne({ email: "a@x.com", publicId: "INF100001", isPremium: true, premiumSource: "admin" });
    await db.collection("brands").insertOne({ email: "b@x.com", publicId: "BRD100002" });

    process.env.BACKUP_ENCRYPTION_KEY = "a".repeat(64);
    await db.collection("database_backups").insertOne({ at: new Date(), status: "ok" });
    const checks = await runIntegrityChecks(db);
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
    expect(checks).toHaveLength(22);
  });

  it("finds collected money with no way out, and invites waiting on an ended campaign", async () => {
    const verified = { transactionType: "paid_collab", collectionStatus: "verified", payoutStatus: "pending", payerTotal: 100000 };
    const closedDispute = new Types.ObjectId();
    const withdrawn = new Types.ObjectId();
    const reviewing = new Types.ObjectId();
    const refunding = new Types.ObjectId();
    const party = () => ({ campaignId: new Types.ObjectId().toHexString(), influencerId: new Types.ObjectId() });
    await db.collection("campaigninvites").insertMany([
      { _id: closedDispute, ...party(), status: "disputed", reportedIssue: { reportedAt: new Date(), resolvedAt: new Date() } },
      { _id: withdrawn, ...party(), status: "withdrawn" },
      { _id: reviewing, ...party(), status: "disputed", reportedIssue: { reportedAt: new Date() } }, // still in the queue
      { _id: refunding, ...party(), status: "withdrawn" },
    ]);
    await db.collection("campaigntransactions").insertMany([
      { ...verified, inviteId: closedDispute },
      { ...verified, inviteId: withdrawn, refundStatus: "none" },
      { ...verified, inviteId: reviewing },
      { ...verified, inviteId: refunding, refundStatus: "owed" }, // on its way back
    ]);
    const ended = new Types.ObjectId();
    await db.collection("campaigns").insertMany([{ _id: ended, status: "completed", campaignNumber: 7 }, { status: "active" }]);
    await db.collection("campaigninvites").insertMany([
      { campaignId: String(ended), influencerId: new Types.ObjectId(), status: "pending" },
      { campaignId: String(ended), influencerId: new Types.ObjectId(), status: "approved" },
    ]);

    const c = await byKey();
    expect(c.collected_money_settles.count).toBe(2);
    expect(c.collected_money_settles.samples.join(" ")).toContain("closed without deciding");
    expect(c.collected_money_settles.samples.join(" ")).toContain("invite is withdrawn");
    expect(c.invites_close_with_campaign.samples).toEqual([expect.stringContaining("campaign 7 is completed")]);
  });

  it("every check with 'Mark as explained' buttons is accepted by the explain endpoint", async () => {
    const { EXPLAINABLE_CHECKS } = require("./data-integrity.service");
    const checks = await runIntegrityChecks(db);
    for (const c of checks.filter((x) => x.refs !== undefined)) {
      expect(EXPLAINABLE_CHECKS).toContain(c.key);
    }
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
    const anon = new Types.ObjectId();
    await db.collection("photographers").insertOne({ _id: anon, anonymized: true });
    await db.collection("profile_flags").insertMany([{ userId: new Types.ObjectId().toHexString() }, { userId: String(premium.insertedId) }]);
    await db.collection("notifications").insertOne({ userId: String(anon) });
    await db.collection("brands").insertMany([
      { email: "half@x.in", publicId: "BRD1", status: "accepted", verificationStatus: "approved", verifiedByTrendStarz: false },
      { email: "pending@x.in", publicId: "BRD2", status: "pending", verificationStatus: "approved", verifiedByTrendStarz: true },
    ]);

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
    expect(c.personal_data_after_delete.samples).toEqual(["notifications: 1", "profile_flags: 1"]);
    expect(c.approval_fields_agree.samples.join(" ")).toMatch(/half@x\.in.*|pending@x\.in/);
    expect(c.approval_fields_agree.count).toBe(2);
    expect(c.public_ids_present.status).toBe("warn"); // the accounts above have no ID number
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

  it("flags one bank transfer (UTR) used for two payments", async () => {
    const row = (utr: string, batch: string, status = "verified") => ({
      transactionType: "paid_collab", inviteId: new Types.ObjectId(), campaignId: "c1",
      utrNumber: utr, paymentBatchId: batch, collectionStatus: status,
      agreedAmount: 100, payerTotal: 100, recipientPayout: 100,
    });
    await db.collection("campaigntransactions").insertMany([
      row("UTR111", "b1"), row("UTR111", "b1"), // two creators, one transfer: fine
      row("UTR222", "b2"), row("utr 222", "b3"), // reused across batches (spacing/case ignored)
      row("UTR333", "b4"), row("UTR333", "b5", "failed"), // rejected proof doesn't count
      row("UTR444", "b6"),
    ]);
    await db.collection("payments").insertOne({ transactionId: "UTR444" }); // also used for Premium
    const c = (await byKey()).utr_used_twice;
    expect(c.count).toBe(2);
    expect(c.refs).toEqual(expect.arrayContaining(["utr:UTR222", "utr:UTR444"]));
  });

  it("flags a paid TrendScore re-analysis that never produced a score", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const delivered = new Types.ObjectId();
    const missing = new Types.ObjectId();
    const recent = new Types.ObjectId();
    const pay = (userId: Types.ObjectId, at: Date, extra: any = {}) => ({
      userId, purpose: "collab_score_reanalysis", status: "approved", gatewayVerifiedAt: at,
      amount: 9900, amountPaise: 9900, ...extra,
    });
    const missingPayment = await db.collection("payments").insertOne(pay(missing, old));
    await db.collection("payments").insertMany([
      pay(delivered, old),
      pay(recent, new Date()), // still within 15 minutes
      pay(new Types.ObjectId(), old, { reanalysisDeliveredAt: new Date() }),
    ]);
    await db.collection("collaboration_audits").insertOne({ userId: String(delivered), isPaid: true, createdAt: new Date(old.getTime() + 5000) });
    const c = (await byKey()).paid_rescore_delivered;
    expect(c.count).toBe(1);
    expect(c.refs).toEqual([String(missingPayment.insertedId)]);
  });

  it("flags open invites and unsettled payments whose records were deleted", async () => {
    const live = new Types.ObjectId();
    await db.collection("campaigns").insertOne({ _id: live, brandId: "h", status: "active" });
    const goneCampaign = new Types.ObjectId().toHexString();
    const openOrphan = await db.collection("campaigninvites").insertOne({ campaignId: goneCampaign, status: "accepted" });
    await db.collection("campaigninvites").insertOne({ campaignId: goneCampaign, status: "declined" }); // closed: fine
    await db.collection("campaigninvites").insertOne({ campaignId: String(live), status: "accepted" }); // fine
    const txRow = (extra: any) => ({ transactionType: "paid_collab", inviteId: new Types.ObjectId(), campaignId: String(live), collectionStatus: "verified", agreedAmount: 100, payerTotal: 100, recipientPayout: 100, ...extra });
    const stuck = await db.collection("campaigntransactions").insertOne(txRow({ payoutStatus: "pending" }));
    await db.collection("campaigntransactions").insertOne(txRow({ payoutStatus: "skipped", refundStatus: "sent" })); // settled: fine
    const c = (await byKey()).dangling_references;
    expect(c.count).toBe(2);
    expect(c.refs).toEqual(expect.arrayContaining([`invite:${openOrphan.insertedId}`, `tx:${stuck.insertedId}`]));
  });

  it("checks that every TrendStarZ credit lot adds up", async () => {
    const good = new Types.ObjectId();
    const bad = new Types.ObjectId();
    await db.collection("platform_credits").insertMany([
      // ₹50 issued: ₹20 spent, ₹5 spent then given back, ₹10 expired → ₹20 left. Adds up.
      { _id: good, type: "issued", ownerId: "h1", amount: 5000, remaining: 2500 },
      { type: "used", lotId: good, amount: 2000 },
      { type: "used", lotId: good, amount: 500, restoredAt: new Date() },
      { type: "expired", lotId: good, amount: 500 },
      // ₹50 issued, ₹10 spent, but ₹50 still left: ₹10 appeared from nowhere.
      { _id: bad, type: "issued", ownerId: "h2", amount: 5000, remaining: 5000 },
      { type: "used", lotId: bad, amount: 1000 },
    ]);
    const c = (await byKey()).credit_ledger_adds_up;
    expect(c.count).toBe(1);
    expect(c.refs).toEqual([`platform_credits:${bad}`]);
  });

  it("an admin can explain a flagged record: it stops counting, the record is untouched", async () => {
    const inv = new Types.ObjectId();
    await db.collection("campaigninvites").insertOne({
      _id: inv, campaignId: new Types.ObjectId().toHexString(), brandId: new Types.ObjectId().toHexString(),
      influencerId: new Types.ObjectId(), status: "completed", unlocked: true, unlockType: "paid_collab_payment",
    });
    const service = new DataIntegrityService(tdb.conn as any, {} as any);
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
