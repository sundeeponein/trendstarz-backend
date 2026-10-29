import { CampaignSchema } from "../database/schemas/profile.schemas";
import { sanitizeFileShareRow } from "../utils/file-share-video.util";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "./mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("Video (File Share) campaign round trip (real MongoDB)", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db?.stop(); });

  it("keeps aspect ratio and share email on create and on update", async () => {
    const Campaign = db.conn.model("Campaign", CampaignSchema, "campaigns");
    const row = sanitizeFileShareRow({
      platform: "Video (File Share)",
      contentTypes: [
        { name: "Raw video", enabled: true, price: 1500, aspectRatio: "9:16" },
        { name: "Edited video", enabled: false, price: null },
      ],
    });
    const doc: any = new Campaign({ title: "t", brandId: "b", status: "draft" });
    Object.assign(doc, { socialMedia: [row], fileShareAccessEmail: "team@brand.in" });
    await doc.save({ validateBeforeSave: false });
    let stored: any = await Campaign.findById(doc._id).lean();
    expect(stored.socialMedia[0].contentTypes[0].aspectRatio).toBe("9:16");
    expect(stored.fileShareAccessEmail).toBe("team@brand.in");

    const edit: any = await Campaign.findById(doc._id);
    const row2 = sanitizeFileShareRow({
      platform: "Video (File Share)",
      contentTypes: [
        { name: "Raw video", enabled: true, price: 1500, aspectRatio: "16:9" },
        { name: "Edited video", enabled: true, price: 3000, aspectRatio: "both" },
      ],
    });
    Object.assign(edit, { socialMedia: [row2], fileShareAccessEmail: "x@brand.in" });
    await edit.save({ validateBeforeSave: false });
    stored = await Campaign.findById(doc._id).lean();
    expect(stored.socialMedia[0].contentTypes.map((c: any) => c.aspectRatio)).toEqual(["16:9", "both"]);
    expect(stored.fileShareAccessEmail).toBe("x@brand.in");
  });
});
