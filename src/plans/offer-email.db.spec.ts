import { Schema, Types } from "mongoose";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.mock("../utils/app-email.service", () => ({ sendAppEmail: jest.fn().mockResolvedValue({}) }));
import { sendAppEmail } from "../utils/app-email.service";
import { OfferEmailService } from "./offer-email.service";
import { offerUnsubscribeToken } from "./offer-email.util";
import { getJwtSecret } from "../auth/jwt-secret";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("offer email to free creators (real MongoDB)", () => {
  let db: TestDb;
  let service: OfferEmailService;
  const planId = new Types.ObjectId();
  const day = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    delete process.env.BREVO_API_KEY;
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    service = new (OfferEmailService as any)(
      loose("Plan", "plans"),
      loose("Influencer", "influencers"),
      loose("Brand", "brands"),
      loose("Photographer", "photographers"),
      loose("AppSettings", "appsettings"),
    );
    await db.conn.collection("plans").insertOne({
      _id: planId,
      userType: "INFLUENCER",
      isActive: true,
      founderOfferName: "Diwali Offer",
      founderOfferEndsAt: new Date(Date.now() + 10 * day),
      price: { monthly: 399, quarterly: 1079, yearly: 3789 },
      offers: [{ key: "discountYearly", value: 75 }],
    });
  });
  afterAll(() => db.stop());

  const waitForFinish = async (kind: string) => {
    for (let i = 0; i < 100; i++) {
      const p: any = await service.preview(String(planId), kind);
      if (p.progress?.finishedAt) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("send did not finish");
  };

  it("emails each free, live creator once and skips Premium, deleted, declined and opted-out accounts", async () => {
    const now = Date.now();
    const free = (extra: any = {}) => ({ _id: new Types.ObjectId(), name: "A", email: `u${Math.random()}@x.in`, status: "accepted", ...extra });
    const people = {
      freeAccepted: free(),
      freePending: free({ status: "pending" }),
      lapsedPremium: free({ isPremium: true, premiumEnd: new Date(now - day) }),
      premium: free({ isPremium: true, premiumEnd: new Date(now + 30 * day) }),
      deleted: free({ isDeleted: true }),
      declined: free({ status: "declined" }),
      optedOut: free({ offerEmailsOptOut: true }),
      noEmail: free({ email: "" }),
    };
    await db.conn.collection("influencers").insertMany(Object.values(people));

    const before: any = await service.preview(String(planId), "launch");
    expect(before.canSend).toBe(true);
    expect(before.recipients).toBe(3);
    expect(before.subject).toContain("₹947");
    expect(before.html).toContain("₹3,789");

    await service.sendAll(String(planId), "launch", ["More invites"], 250);
    const done = await waitForFinish("launch");
    expect(done.progress.sent).toBe(3);
    const sentTo = (sendAppEmail as jest.Mock).mock.calls.map((c) => c[0].to).sort();
    expect(sentTo).toEqual([people.freeAccepted, people.freePending, people.lapsedPremium].map((p) => p.email.toLowerCase()).sort());

    // Pressing Send again sends nobody twice; the reminder is a separate email.
    (sendAppEmail as jest.Mock).mockClear();
    await service.sendAll(String(planId), "launch", [], 250);
    expect((await waitForFinish("launch")).progress.sent).toBe(0);
    expect(sendAppEmail).not.toHaveBeenCalled();
    expect((await service.preview(String(planId), "reminder")).notYetSent).toBe(3);
  });

  it("refuses to send once the offer has ended", async () => {
    await db.conn.collection("plans").updateOne({ _id: planId }, { $set: { founderOfferEndsAt: new Date(Date.now() - 2 * day) } });
    const p: any = await service.preview(String(planId), "launch");
    expect(p.canSend).toBe(false);
    await expect(service.sendAll(String(planId), "launch", [], 10)).rejects.toThrow(/ended/);
    await db.conn.collection("plans").updateOne({ _id: planId }, { $set: { founderOfferEndsAt: new Date(Date.now() + 10 * day) } });
  });

  it("the Stop offer emails link opts that account out, and a forged link does nothing", async () => {
    const id = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({ _id: id, email: "z@x.in", status: "accepted" });
    await expect(service.unsubscribe(`influencer.${id}.forged`)).rejects.toThrow();
    await service.unsubscribe(offerUnsubscribeToken("influencer", String(id), getJwtSecret()));
    expect(((await db.conn.collection("influencers").findOne({ _id: id })) as any).offerEmailsOptOut).toBe(true);
  });
});
