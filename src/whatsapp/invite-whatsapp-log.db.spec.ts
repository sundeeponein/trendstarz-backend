import { Types } from "mongoose";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { isAfterPostDateIst, recordInviteWhatsApp, recordManualInviteWhatsApp } from "./invite-whatsapp-log";

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

  const newInvite = async () => {
    const _id = new Types.ObjectId();
    await invites.collection.insertOne({ _id, campaignId: "c1", brandId: "b1", influencerId: new Types.ObjectId(), status: "accepted" });
    return _id;
  };

  it("manual sends stop at the message's limit, counting automatic sends", async () => {
    const id = await newInvite();
    await recordInviteWhatsApp(invites, id, "startWork", "auto");
    expect(await recordManualInviteWhatsApp(invites, id, "startWork")).toBe(false);

    expect(await recordManualInviteWhatsApp(invites, id, "submitted")).toBe(true);
    expect(await recordManualInviteWhatsApp(invites, id, "submitted")).toBe(true);
    expect(await recordManualInviteWhatsApp(invites, id, "submitted")).toBe(false);
    const doc: any = await invites.findById(id).lean();
    expect(doc.whatsappLog.submitted.count).toBe(2);
  });

  it("two admins at once: only one gets through", async () => {
    const id = await newInvite();
    const results = await Promise.all([
      recordManualInviteWhatsApp(invites, id, "accepted"),
      recordManualInviteWhatsApp(invites, id, "accepted"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("posting reminder: one per India day, five in total", async () => {
    const id = await newInvite();
    const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 6, 0)); // 11:30 IST
    expect(await recordManualInviteWhatsApp(invites, id, "postingReminder", day(0))).toBe(true);
    // Same India day (23:00 IST) — refused.
    expect(await recordManualInviteWhatsApp(invites, id, "postingReminder", new Date(Date.UTC(2026, 10, 10, 17, 30)))).toBe(false);
    for (let n = 1; n <= 4; n++) {
      expect(await recordManualInviteWhatsApp(invites, id, "postingReminder", day(n))).toBe(true);
    }
    expect(await recordManualInviteWhatsApp(invites, id, "postingReminder", day(5))).toBe(false);
  });

  it("post date check uses India days", () => {
    const post = new Date("2026-11-15T18:00:00Z"); // 15 Nov 23:30 IST
    expect(isAfterPostDateIst(post, new Date("2026-11-15T18:20:00Z"))).toBe(false); // 15 Nov 23:50 IST
    expect(isAfterPostDateIst(post, new Date("2026-11-15T18:31:00Z"))).toBe(true); // 16 Nov 00:01 IST
    expect(isAfterPostDateIst(null)).toBe(false);
  });

  it("ignores unknown types and missing ids without throwing", async () => {
    await expect(recordInviteWhatsApp(invites, "", "startWork", "auto")).resolves.toBeUndefined();
    await expect(recordInviteWhatsApp(invites, new Types.ObjectId(), "nope" as any, "auto")).resolves.toBeUndefined();
  });
});
