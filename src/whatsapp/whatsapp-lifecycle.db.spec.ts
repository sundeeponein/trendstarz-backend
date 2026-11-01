import { Schema, Types } from "mongoose";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.mock("../utils/whatsapp-cloud-api.util", () => ({
  sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue({ messages: [{ id: "wamid" }] }),
}));
import { sendWhatsAppTemplateMessage } from "../utils/whatsapp-cloud-api.util";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppLifecycleService } from "./whatsapp-lifecycle.service";
import { PlansService } from "../plans/plans.service";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("automatic WhatsApp after signup and on Premium (real MongoDB)", () => {
  let db: TestDb;
  let lifecycle: WhatsAppLifecycleService;
  let plans: PlansService;
  const send = sendWhatsAppTemplateMessage as jest.Mock;
  const HOUR = 3600 * 1000;
  const ORIGINAL = process.env.WHATSAPP_TEMPLATES;

  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    const [inf, brand, photo, prefs] = [
      loose("Influencer", "influencers"),
      loose("Brand", "brands"),
      loose("Photographer", "photographers"),
      loose("NotificationPreference", "notificationpreferences"),
    ];
    const wa = new WhatsAppService(prefs as any);
    lifecycle = new WhatsAppLifecycleService(inf as any, brand as any, photo as any, wa);
    plans = new (PlansService as any)(loose("Plan", "plans"), loose("Subscription", "subscriptions"), inf, brand, photo, wa);
  });
  afterAll(async () => {
    process.env.WHATSAPP_TEMPLATES = ORIGINAL;
    await db.stop();
  });
  beforeEach(() => send.mockClear());

  it("sends nothing while the templates are not switched on", async () => {
    delete process.env.WHATSAPP_TEMPLATES;
    await db.conn.collection("influencers").insertOne({ name: "New", phoneNumber: "9876543210", createdAt: new Date() });
    expect(await lifecycle.sendWelcomes()).toBe(0);
    expect(await lifecycle.sendMobileReminders()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await db.conn.collection("influencers").deleteMany({});
  });

  it("welcomes only new accounts, once; reminds unverified mobiles once after a day", async () => {
    process.env.WHATSAPP_TEMPLATES = "welcome_user,mobile_otp_verification_reminder";
    const now = new Date();
    const fresh = new Types.ObjectId();
    const old = new Types.ObjectId();
    const dayOld = new Types.ObjectId();
    const optedOut = new Types.ObjectId();
    await db.conn.collection("influencers").insertMany([
      { _id: fresh, name: "Fresh", phoneNumber: "9876543210", status: "pending", createdAt: new Date(now.getTime() - HOUR) },
      { _id: old, name: "Old", phoneNumber: "9876543211", status: "accepted", createdAt: new Date(now.getTime() - 30 * 24 * HOUR) },
      { _id: dayOld, name: "DayOld", phoneNumber: "9876543212", status: "pending", isMobileVerified: false, welcomeWhatsappSentAt: new Date(), createdAt: new Date(now.getTime() - 30 * HOUR) },
      { _id: optedOut, name: "Quiet", phoneNumber: "9876543213", status: "pending", createdAt: new Date(now.getTime() - HOUR) },
    ]);
    await db.conn.collection("notificationpreferences").insertOne({ userId: String(optedOut), whatsappEnabled: false });

    expect(await lifecycle.sendWelcomes(now)).toBe(1);
    expect(send.mock.calls.map((c) => c[0].to)).toEqual(["9876543210"]);
    expect(send.mock.calls[0][0].templateName).toBe("welcome_user");
    expect(await lifecycle.sendWelcomes(now)).toBe(0); // stamped, never twice

    send.mockClear();
    expect(await lifecycle.sendMobileReminders(now)).toBe(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "9876543212", templateName: "mobile_otp_verification_reminder" });
    expect(await lifecycle.sendMobileReminders(now)).toBe(0);
  });

  it("does not stamp when WhatsApp could not deliver, so it retries", async () => {
    process.env.WHATSAPP_TEMPLATES = "welcome_user";
    await db.conn.collection("influencers").deleteMany({});
    const id = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({ _id: id, name: "Retry", phoneNumber: "9876543299", createdAt: new Date() });
    send.mockResolvedValueOnce({ skipped: true, reason: "not configured" });
    expect(await lifecycle.sendWelcomes()).toBe(0);
    expect(((await db.conn.collection("influencers").findOne({ _id: id })) as any).welcomeWhatsappSentAt ?? null).toBeNull();
    expect(await lifecycle.sendWelcomes()).toBe(1);
  });

  it("Premium activated goes to a verified mobile with the plan end date", async () => {
    process.env.WHATSAPP_TEMPLATES = "premium_activated";
    const id = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({
      _id: id, name: "Paid", phoneNumber: "9876500000", isMobileVerified: true, premiumEnd: new Date("2027-10-31T10:00:00Z"),
    });
    await plans.notifyPremiumActivated(String(id), "Influencer");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "premium_activated",
        bodyParams: ["Paid", "Premium Creator Membership", "31 Oct 2027", expect.stringContaining("/influencer-dashboard")],
      }),
    );
  });
});
