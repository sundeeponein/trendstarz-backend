import { Schema, Types } from "mongoose";
import { InviteViewsService, INVITE_VIEWS } from "./invite-views.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("invite views (real MongoDB)", () => {
  let db: TestDb;
  let service: InviteViewsService;
  const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);

  beforeAll(async () => {
    db = await startTestDb();
    service = new InviteViewsService(
      loose("CampaignInvite", "campaigninvites"),
      loose("Campaign", "campaigns"),
      loose("Influencer", "influencers"),
      loose("Brand", "brands"),
      loose("Photographer", "photographers"),
    );
  });
  afterAll(() => db.stop());

  it("records only the recipient / owner, once a minute, and shows admin who is being waited on", async () => {
    const brand = new Types.ObjectId();
    const creator = new Types.ObjectId();
    const campaignId = new Types.ObjectId();
    const inviteId = new Types.ObjectId();
    const accepted = new Date(Date.now() - 60 * 60 * 1000);
    await db.conn.collection("campaigns").insertOne({ _id: campaignId, brandId: String(brand), campaignType: "paid_collab" });
    await db.conn.collection("brands").insertOne({ _id: brand, brandName: "Glow Co", phoneNumber: "9876543210", lastLoginAt: new Date(accepted.getTime() - 1000) });
    await db.conn.collection("influencers").insertOne({ _id: creator, name: "Priya", phoneNumber: "9123456780" });
    await db.conn.collection("campaigninvites").insertOne({
      _id: inviteId, campaignId: String(campaignId), brandId: String(brand), influencerId: creator, status: "accepted", acceptedAt: accepted,
    });

    expect((await service.recordInviteView(String(inviteId), String(brand))).recorded).toBe(false); // host isn't the recipient
    await service.recordInviteView(String(inviteId), String(creator));
    await service.recordInviteView(String(inviteId), String(creator)); // within a minute: not counted again
    await expect(service.recordCampaignView(String(campaignId), String(creator))).rejects.toThrow(/Not your campaign/);

    const views = await db.conn.collection(INVITE_VIEWS).find({}).toArray();
    expect(views.map((v: any) => [v.kind, v.count])).toEqual([["invite", 1]]);

    let res = await service.adminCampaignFollowUps(String(campaignId));
    expect(res.followUps[String(inviteId)]).toMatchObject({
      waitingOn: "host", reason: "Pay to confirm the creator", seenSince: false, activeSince: false, hostPhone: "9876543210", hostName: "Glow Co",
    });

    await service.recordCampaignView(String(campaignId), String(brand));
    res = await service.adminCampaignFollowUps(String(campaignId));
    expect(res.followUps[String(inviteId)].seenSince).toBe(true);
  });
});
