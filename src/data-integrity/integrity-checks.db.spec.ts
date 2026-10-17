import { Types } from "mongoose";
import { runIntegrityChecks, REQUIRED_INDEXES } from "./integrity-checks";
import { warningSignature } from "./data-integrity.service";
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
    await db.collection("campaigntransactions").insertOne({ campaignId: camp, inviteId: inv, payerId: new Types.ObjectId().toHexString(), recipientId: new Types.ObjectId().toHexString(), payerTotal: 100000, collectionStatus: "verified" });
    await db.collection("payments").insertOne({ amount: 499, amountPaise: 49900, status: "approved" });
    await db.collection("influencers").insertOne({ email: "a@x.com", isPremium: true, premiumSource: "admin" });
    await db.collection("brands").insertOne({ email: "b@x.com" });

    const checks = await runIntegrityChecks(db);
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
    expect(checks).toHaveLength(9);
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

  it("the alert fingerprint changes only when what's wrong changes", () => {
    const warn = (key: string, count: number) => ({ key, label: key, status: "warn" as const, count, help: "", samples: [] });
    const ok = { key: "x", label: "x", status: "ok" as const, count: 0, help: "", samples: [] };
    expect(warningSignature([warn("a", 1), ok])).toBe(warningSignature([ok, warn("a", 1)]));
    expect(warningSignature([warn("a", 1)])).not.toBe(warningSignature([warn("a", 2)]));
  });
});
