import { Schema, Types } from "mongoose";
import { UsersService } from "./users.service";
import { InfluencerSchema } from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe('"Download my data" (real MongoDB)', () => {
  let db: TestDb;
  let service: any;

  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    service = Object.assign(Object.create(UsersService.prototype), {
      influencerModel: db.conn.model("Influencer", InfluencerSchema, "influencers"),
      brandModel: loose("Brand", "brands"),
      photographerModel: loose("Photographer", "photographers"),
      campaignInviteModel: db.conn.model("CampaignInvite", CampaignInviteSchema, "campaigninvites"),
    });
  });
  afterAll(() => db.stop());

  it("contains the person's own data, without secrets, admin notes or the other side's private details", async () => {
    const me = new Types.ObjectId();
    const brand = new Types.ObjectId();
    const campaign = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({
      _id: me, name: "Asha", email: "asha@x.in", username: "asha", phoneNumber: "9876543210",
      password: "$2a$10$hash", resetToken: "tok", firebaseUid: "fb-1",
      verificationAdminNotes: "called her, sounded legit", adminTags: ["Internal/Test"],
      payout: { upiId: "asha@upi" }, dateOfBirth: new Date("1999-01-01"),
      termsAcceptedAt: new Date("2026-10-26"), termsVersion: "2026-02-24", privacyVersion: "2026-02-24",
    });
    await db.conn.collection("brands").insertOne({ _id: brand, brandName: "Acme", payout: { upiId: "acme@upi" }, phoneNumber: "9000000000" });
    await db.conn.collection("campaigns").insertOne({ _id: campaign, title: "Diwali Reels", campaignNumber: 30 });
    const inv = new Types.ObjectId();
    await db.conn.collection("campaigninvites").insertOne({ _id: inv, campaignId: String(campaign), brandId: String(brand), influencerId: me, status: "completed", agreedAmount: 1000 });
    await db.conn.collection("campaigntransactions").insertOne({
      campaignId: String(campaign), inviteId: inv, payerId: String(brand), recipientId: String(me),
      payerTotal: 105000, platformFee: 5000, recipientPayout: 95000, recipientFee: 5000, payoutStatus: "paid",
    });
    await db.conn.collection("reviews").insertOne({ targetId: String(me), status: "approved", rating: 5, comment: "Great reel", reviewerType: "brand" });

    const out = await service.exportMyData(String(me), "influencer");
    const text = JSON.stringify(out);

    expect(out.account).toMatchObject({ name: "Asha", email: "asha@x.in", payout: { upiId: "asha@upi" } });
    expect(out.consent).toMatchObject({ termsVersion: "2026-02-24" });
    expect(out.collaborations).toEqual([expect.objectContaining({ campaign: "#30 Diwali Reels", status: "completed", yourRole: "creator" })]);
    expect(out.payments).toEqual([expect.objectContaining({ side: "paid to you", payoutPaise: 95000, payoutStatus: "paid" })]);
    expect(out.payments[0].amountPaise).toBeUndefined(); // the brand's side isn't hers
    expect(out.reviews.aboutYou).toHaveLength(1);
    for (const hidden of ["$2a$10$hash", "tok", "fb-1", "sounded legit", "Internal/Test", "acme@upi", "9000000000"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("only exists for influencer, brand and photographer accounts", async () => {
    await expect(service.exportMyData(String(new Types.ObjectId()), "admin")).rejects.toThrow(/Data export is for/);
  });
});
