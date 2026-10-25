import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { DB_TEST_TIMEOUT_MS } from "./mongo-replset.fixture-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require("../../cron/restoreVerificationLostOnSave.js");

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("cron/restoreVerificationLostOnSave.js (real MongoDB)", () => {
  let rs: MongoMemoryReplSet;
  let client: MongoClient;
  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    client = await new MongoClient(rs.getUri()).connect();
  });
  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  const approved = { action: "approved", status: "approved", actorRole: "admin" };
  const autoReset = { action: "status_changed", status: "not_submitted", note: "Influencer removed verification documents", actorRole: "influencer" };

  it("restores only approvals that a profile save took away", async () => {
    const db = client.db("restore");
    const lost = new ObjectId();
    const rejected = new ObjectId();
    const resubmitted = new ObjectId();
    const neverApproved = new ObjectId();
    const base = { verificationStatus: "not_submitted", verifiedByTrendStarz: false };
    await db.collection("influencers").insertMany([
      { _id: lost, ...base, verificationAuditLog: [approved, autoReset, autoReset] },
      { _id: rejected, ...base, verificationStatus: "rejected", verificationAuditLog: [approved, autoReset, { action: "rejected", status: "rejected", actorRole: "admin" }] },
      { _id: resubmitted, ...base, verificationStatus: "pending", verificationAuditLog: [approved, { action: "submitted", status: "pending", actorRole: "influencer" }] },
      { _id: neverApproved, ...base, verificationAuditLog: [autoReset] },
    ]);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await script.run(db, { apply: false })).toMatchObject({ candidates: 3, restore: 1, restored: 0 });
    expect(((await db.collection("influencers").findOne({ _id: lost })) as any).verifiedByTrendStarz).toBe(false);

    await script.run(db, { apply: true });
    const after: any = await db.collection("influencers").findOne({ _id: lost });
    expect(after).toMatchObject({ verificationStatus: "approved", verifiedByTrendStarz: true });
    expect(after.verificationAuditLog.at(-1).note).toContain("Approval restored");
    for (const id of [rejected, resubmitted, neverApproved]) {
      expect(((await db.collection("influencers").findOne({ _id: id })) as any).verifiedByTrendStarz).toBe(false);
    }
    expect(await script.run(db, { apply: true })).toMatchObject({ restore: 0 }); // re-run is a no-op
    log.mockRestore();
  });
});
