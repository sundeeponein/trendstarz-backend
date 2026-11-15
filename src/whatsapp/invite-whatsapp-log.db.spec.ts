import { Types } from "mongoose";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { recordInviteWhatsApp } from "./invite-whatsapp-log";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("invite WhatsApp send log (real MongoDB)", () => {
  let db: TestDb;
  let invites: any;

  beforeAll(async () => {
    db = await startTestDb();
    invites = db.conn.model("CampaignInvite", CampaignInviteSchema, "campaigninvites");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("counts each send and keeps the last time and how it went", async () => {
    const _id = new Types.ObjectId();
    await invites.collection.insertOne({ _id, campaignId: "c1", brandId: "b1", influencerId: new Types.ObjectId(), status: "accepted" });

    const first = new Date("2026-11-11T11:34:58Z");
    const second = new Date("2026-11-12T08:00:00Z");
    await recordInviteWhatsApp(invites, _id, "startWork", "auto", first);
    await recordInviteWhatsApp(invites, _id, "startWork", "manual", second);
    await recordInviteWhatsApp(invites, _id, "postingReminder", "auto", first);

    const doc: any = await invites.findById(_id).lean();
    expect(doc.whatsappLog.startWork).toEqual({ count: 2, lastSentAt: second, lastVia: "manual" });
    expect(doc.whatsappLog.postingReminder).toEqual({ count: 1, lastSentAt: first, lastVia: "auto" });
    expect(doc.whatsappLog.paymentReceived).toBeUndefined();
  });

  it("ignores unknown types and missing ids without throwing", async () => {
    await expect(recordInviteWhatsApp(invites, "", "startWork", "auto")).resolves.toBeUndefined();
    await expect(recordInviteWhatsApp(invites, new Types.ObjectId(), "nope" as any, "auto")).resolves.toBeUndefined();
  });
});
