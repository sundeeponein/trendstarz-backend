import { Types } from "mongoose";
import { CampaignInvitesService } from "./campaign-invites.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("who may upload proof images (real MongoDB)", () => {
  let db: TestDb;
  let ctx: any;
  const host = new Types.ObjectId().toHexString();
  const creator = new Types.ObjectId();
  const stranger = new Types.ObjectId().toHexString();
  let campaignId: string;
  let inviteId: string;

  beforeAll(async () => {
    db = await startTestDb();
    const campaigns = db.conn.collection("campaigns");
    const invites = db.conn.collection("campaigninvites");
    campaignId = String((await campaigns.insertOne({ brandId: host })).insertedId);
    inviteId = String((await invites.insertOne({ campaignId, brandId: host, influencerId: creator })).insertedId);
    const model = (c: any) => ({
      findById: (id: any) => ({
        select: () => ({ lean: () => c.findOne({ _id: new Types.ObjectId(String(id)) }) }),
      }),
    });
    ctx = { inviteModel: model(invites), campaignModel: model(campaigns) };
  });
  afterAll(async () => db?.stop());

  const call = (id: string, who: string, role = "influencer") =>
    (CampaignInvitesService.prototype as any).proofUploadCampaignId.call(ctx, id, who, role);

  it("invite parties upload into the invite's campaign; others are refused", async () => {
    await expect(call(inviteId, String(creator))).resolves.toBe(campaignId);
    await expect(call(inviteId, host, "brand")).resolves.toBe(campaignId);
    await expect(call(inviteId, stranger)).rejects.toThrow("does not belong to you");
  });

  it("the host's payment screenshot (campaign id) goes to that campaign; only for its owner", async () => {
    await expect(call(campaignId, host, "brand")).resolves.toBe(campaignId);
    await expect(call(campaignId, stranger, "brand")).rejects.toThrow("does not belong to you");
  });

  it("admins may upload payout proofs with any id; unknown ids are refused for everyone else", async () => {
    await expect(call("payout", stranger, "admin")).resolves.toBeNull();
    await expect(call("payout", stranger)).rejects.toThrow("not found");
  });
});
