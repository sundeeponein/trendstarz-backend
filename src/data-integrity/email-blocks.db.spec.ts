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
      { email: "bounced@x.in", role: "influencer", accountId: String(bounced), reason: "Hard bounce", blockedAt: "2026-10-01" },
    ]);
  });
});
