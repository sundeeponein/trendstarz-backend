import { Types } from "mongoose";
import { CollaborationScoreService } from "./collaboration-score.service";
import { CollaborationAuditSchema } from "../database/schemas/collaboration-audit.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("one current Collaboration Score per person (real MongoDB)", () => {
  let db: TestDb;
  let Audit: any;
  let service: CollaborationScoreService;

  beforeAll(async () => {
    db = await startTestDb();
    Audit = db.conn.model("CollaborationAudit", CollaborationAuditSchema, "collaboration_audits");
    service = Object.assign(Object.create(CollaborationScoreService.prototype), { auditModel: Audit });
  });
  afterAll(() => db.stop());

  it("keeps the newest version current even when the older run finishes last", async () => {
    const user = new Types.ObjectId().toHexString();
    const base = { userId: user, userType: "Influencer", status: "completed", isCurrent: true };
    const v4 = await Audit.collection.insertOne({ ...base, version: 4 }); // the later run saved first
    const v3 = await Audit.collection.insertOne({ ...base, version: 3 }); // the earlier run finishes last
    await service.retireOlderAudits(user, v3.insertedId);
    const current = await Audit.find({ userId: user, isCurrent: true }).lean();
    expect(current.map((a: any) => a.version)).toEqual([4]);
    expect(String(current[0]._id)).toBe(String(v4.insertedId));
  });
});
