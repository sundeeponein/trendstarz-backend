import { Schema, Types } from "mongoose";
import { CollaborationRecordService } from "./collaboration-record.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("collaboration record (real MongoDB)", () => {
  let db: TestDb;
  let service: CollaborationRecordService;

  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    service = new CollaborationRecordService(
      loose("CampaignInvite", "campaigninvites"),
      loose("CampaignSubmission", "campaignsubmissions"),
      loose("Influencer", "influencers"),
      loose("Brand", "brands"),
      loose("Photographer", "photographers"),
    );
  });
  afterAll(() => db.stop());

  it("counts invites received (ObjectId) and sent (string id), with late posts from submissions", async () => {
    const creator = new Types.ObjectId();
    const other = new Types.ObjectId();
    const late = new Types.ObjectId();
    await db.conn.collection("campaigninvites").insertMany([
      { _id: late, influencerId: creator, brandId: String(other), campaignId: "c1", status: "approved" },
      { influencerId: creator, brandId: String(other), campaignId: "c1", status: "declined" },
      // This creator hosting: two invites in one campaign.
      { influencerId: other, brandId: String(creator), campaignId: "c2", status: "completed" },
      { influencerId: new Types.ObjectId(), brandId: String(creator), campaignId: "c2", status: "withdrawn", withdrawnReasonCode: "expired_unsubmitted" },
    ]);
    await db.conn.collection("campaignsubmissions").insertOne({ inviteId: late, isLate: true });

    const r = await service.forUser(String(creator), "influencer");
    expect(r.asCreator).toMatchObject({ total: 2, completedLate: 1, completedOnTime: 0, declined: 1 });
    expect(r.asHost).toMatchObject({ total: 2, campaigns: 1, completedOnTime: 1, didNotPost: 1 });

    const brand = await service.forUser(String(other), "brand");
    expect(brand.asCreator).toBeNull();
    expect(brand.asHost).toMatchObject({ total: 2, completedLate: 1 });

    // Admin list: names from whichever profile the id belongs to; worst no-show first.
    await db.conn.collection("influencers").insertOne({ _id: creator, name: "Priya", username: "priya" });
    await db.conn.collection("brands").insertOne({ _id: other, brandName: "Glow Co" });
    const hosts = await service.listAll("host");
    expect(hosts.rows.map((r: any) => [r.name, r.role, r.didNotPost, r.campaigns])).toEqual([
      ["Priya", "influencer", 1, 1],
      ["Glow Co", "brand", 0, 1],
    ]);
    const creators = await service.listAll("creator");
    expect(creators.rows.find((r: any) => r.userId === String(creator))).toMatchObject({ name: "Priya", completedLate: 1 });
    expect(creators.rows.some((r: any) => r.removed)).toBe(true); // the third recipient has no profile
  });
});
