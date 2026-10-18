import { Schema, Types } from "mongoose";
import { UsersService } from "./users.service";
import { InfluencerSchema } from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("anonymizeUser leaves no personal data behind (real MongoDB)", () => {
  let db: TestDb;
  let service: UsersService;
  let Influencer: any;
  let Invite: any;

  beforeAll(async () => {
    db = await startTestDb();
    Influencer = db.conn.model("Influencer", InfluencerSchema, "influencers");
    Invite = db.conn.model("CampaignInvite", CampaignInviteSchema, "campaigninvites");
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    loose("Notification", "notifications");
    loose("PushSubscription", "pushsubscriptions");
    const audits = loose("CollaborationAudit", "collaboration_audits");
    const payments = loose("Payment", "payments");
    const txs = loose("Transaction", "transactions");
    const oauth = loose("SocialOAuthConnection", "social_oauth_connections");
    const none = {} as any;
    service = new UsersService(
      { deleteImage: jest.fn() } as any, // cloudinary
      { isConfigured: () => false, deleteUserByEmail: jest.fn(), deleteUser: jest.fn() } as any, // firebase
      none, Influencer, none, none, Invite, none, none,
      audits, payments, txs, oauth,
      none, { revokePermissions: jest.fn() } as any, none, none,
      { reconcile: jest.fn() } as any, none,
    );
  });
  afterAll(() => db.stop());

  it("clears payout, identity, history and traces in other collections", async () => {
    const id = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({
      _id: id, name: "Asha Rao", email: "asha@x.com", password: "x", phoneNumber: "9999999999",
      username: "asha.creates", status: "deletion_pending", isDeleted: true,
      payout: { upiId: "asha@upi", mobile: "9999999999", accountHolderName: "Asha Rao" },
      dateOfBirth: new Date("1999-01-01"), gender: "female",
      previousVerifiedEmail: "old@x.com", previousVerifiedMobile: "8888888888",
      signupAttribution: { source: "instagram" }, firebaseUid: "fb_123",
      socialMediaEditLog: [{ oldHandle: "asha_old", newHandle: "asha.creates" }],
      adminSocialNotifications: [{ oldHandle: "asha_old" }],
    });
    await db.conn.collection("notifications").insertOne({ userId: String(id), title: "Hi Asha" });
    await db.conn.collection("pushsubscriptions").insertOne({ userId: String(id), endpoint: "https://push/1" });
    await db.conn.collection("campaigninvites").insertOne({
      campaignId: "c1", brandId: "b1", influencerId: id, status: "completed",
      shippingAddress: { contactName: "Asha Rao", contactMobile: "9999999999", line1: "12 MG Road", city: "Hyderabad", pincode: "500001" },
    });

    await service.anonymizeUser(String(id));

    const u: any = await db.conn.collection("influencers").findOne({ _id: id });
    const blob = JSON.stringify(u);
    for (const leak of ["Asha", "asha@", "9999999999", "8888888888", "old@x.com", "asha_old", "fb_123", "1999-01-01", "instagram"]) {
      expect(blob).not.toContain(leak);
    }
    expect(u).toMatchObject({ anonymized: true, status: "deleted", username: `deleted-${id}` });
    expect(await db.conn.collection("notifications").countDocuments({ userId: String(id) })).toBe(0);
    expect(await db.conn.collection("pushsubscriptions").countDocuments({ userId: String(id) })).toBe(0);
    const inv: any = await db.conn.collection("campaigninvites").findOne({ influencerId: id });
    expect(inv.status).toBe("completed"); // history kept
    expect(inv.shippingAddress).toBeUndefined(); // address gone
  });
});
