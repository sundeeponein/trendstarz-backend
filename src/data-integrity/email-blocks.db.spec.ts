import { Types } from "mongoose";
import { matchEmailBlocks } from "./email-blocks";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("accounts whose email Brevo won't deliver to (real MongoDB)", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await startTestDb();
  });
  afterAll(() => tdb.stop());

  it("lists only live accounts on the blocked list, with Brevo's reason", async () => {
    const db: any = tdb.conn.db;
    const bounced = new Types.ObjectId();
    await db.collection("influencers").insertMany([
      { _id: bounced, email: "Bounced@X.in " },
      { email: "fine@x.in" },
      { email: "gone@x.in", isDeleted: true },
    ]);
    await db.collection("brands").insertOne({ email: "spam@x.in", anonymized: true });
    const r = await matchEmailBlocks(db, [
      { email: "bounced@x.in", reason: { code: "hardBounce", message: "Hard bounce" }, blockedAt: "2026-10-01" },
      { email: "gone@x.in", reason: { code: "hardBounce" } },
      { email: "spam@x.in", reason: { code: "contactFlaggedAsSpam" } },
      { email: "stranger@x.in", reason: { code: "unsubscribedViaEmail" } },
    ]);
    expect(r.blockedInBrevo).toBe(4);
    expect(r.accounts).toEqual([
      { email: "bounced@x.in", role: "influencer", accountId: String(bounced), reason: "Hard bounce", blockedAt: "2026-10-01", openWork: false, openMoney: false },
    ]);
  });

  it("flags blocked people with a campaign or money open, and lists them first", async () => {
    const db: any = tdb.conn.db;
    await db.collection("influencers").deleteMany({});
    const quiet = new Types.ObjectId();
    const working = new Types.ObjectId();
    const owed = new Types.ObjectId();
    await db.collection("influencers").insertMany([
      { _id: quiet, email: "quiet@x.in" },
      { _id: working, email: "working@x.in" },
      { _id: owed, email: "owed@x.in" },
    ]);
    // Stored as an ObjectId on invites, as a string on payments — both must match.
    await db.collection("campaigninvites").insertMany([
      { influencerId: working, brandId: "b1", status: "working" },
      { influencerId: quiet, brandId: "b1", status: "completed" },
    ]);
    await db.collection("campaigntransactions").insertOne({
      recipientId: String(owed), collectionStatus: "verified", payoutStatus: "pending",
    });
    const reason = { code: "unsubscribedViaEmail" };
    const r = await matchEmailBlocks(db, [
      { email: "quiet@x.in", reason },
      { email: "working@x.in", reason },
      { email: "owed@x.in", reason },
    ]);
    const flags = r.accounts.map((a) => [a.email, a.openWork, a.openMoney]);
    expect(flags.slice(0, 2)).toEqual(expect.arrayContaining([["working@x.in", true, false], ["owed@x.in", false, true]]));
    expect(flags[2]).toEqual(["quiet@x.in", false, false]);
  });
});
