import { Types } from "mongoose";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.mock("../utils/app-email.service", () => ({ sendAppEmail: jest.fn().mockResolvedValue(undefined) }));
import { sendAppEmail } from "../utils/app-email.service";
import { ReactivationEmailService, REACTIVATION_SEND_KEY } from "./reactivation-email.service";
import { reactivationEmailTemplate } from "../email/templates/reactivation.templates";
import { OFFER_EMAIL_SENDS } from "../plans/offer-email.service";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

const approved = (over: Record<string, any> = {}) => ({
  _id: new Types.ObjectId(),
  name: "Asha",
  email: `c${Math.random().toString(36).slice(2)}@example.com`,
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  lastLoginAt: ago(200),
  lastOpenedAt: null,
  ...over,
});

describe("reactivation email (real MongoDB)", () => {
  let db: TestDb;
  let service: ReactivationEmailService;
  const send = sendAppEmail as jest.Mock;
  const ORIGINAL_SECRET = process.env.JWT_SECRET;
  const ORIGINAL_BREVO = process.env.BREVO_API_KEY;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-reactivation-email-spec-0123456789";
    delete process.env.BREVO_API_KEY;
    db = await startTestDb();
    service = new ReactivationEmailService(db.conn as any);
  });
  afterAll(async () => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_BREVO !== undefined) process.env.BREVO_API_KEY = ORIGINAL_BREVO;
    await db.stop();
  });

  const waitForSend = async () => {
    for (let i = 0; i < 100; i++) {
      const p = (await service.preview()).progress;
      if (p?.finishedAt) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("send did not finish");
  };

  it("emails only approved creators dormant 90+ days, once each, respecting opt-out", async () => {
    const dormant = approved();
    const neverSeen = approved({ lastLoginAt: null });
    const photographer = approved();
    await db.conn.collection("influencers").insertMany([
      dormant,
      neverSeen,
      approved({ lastLoginAt: ago(10) }), // active
      approved({ lastLoginAt: ago(200), lastOpenedAt: ago(5) }), // opened the app recently
      approved({ offerEmailsOptOut: true }), // opted out
      approved({ verificationStatus: "pending" }), // not approved
      approved({ isDeleted: true }),
      approved({ email: "" }),
    ]);
    await db.conn.collection("photographers").insertOne(photographer);

    const before = await service.preview();
    expect(before.dormant).toBe(3);
    expect(before.notYetSent).toBe(3);

    await service.sendAll(10);
    const p = await waitForSend();
    expect(p.sent).toBe(3);
    expect(send.mock.calls.map((c) => c[0].to).sort()).toEqual(
      [dormant.email, neverSeen.email, photographer.email].sort(),
    );
    // Photographers get their own profile page.
    const photoMail = send.mock.calls.find((c) => c[0].to === photographer.email)[0];
    expect(photoMail.text).toContain("/photographer-profile");
    expect(photoMail.text).toContain("/offer-emails/unsubscribe?t=");

    const rows = await db.conn.collection(OFFER_EMAIL_SENDS).find({ offerKey: REACTIVATION_SEND_KEY }).toArray();
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);

    // Pressing Send again sends nobody a second copy.
    send.mockClear();
    await service.sendAll(10);
    expect((await waitForSend()).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await service.preview()).notYetSent).toBe(0);
  });

  it("stops at the per-press limit", async () => {
    await db.conn.collection("influencers").insertMany([approved(), approved(), approved()]);
    send.mockClear();
    await service.sendAll(2);
    const p = await waitForSend();
    expect(p.sent).toBe(2);
    expect(p.stoppedReason).toMatch(/limit of 2/);
  });

  it("escapes the creator's name in the html", () => {
    const t = reactivationEmailTemplate({
      recipientName: '<a href="https://fake.example">x</a>',
      profileUrl: "https://trendstarz.in/influencer-profile",
      unsubscribeUrl: "https://trendstarz.in/offer-emails/unsubscribe?t=a",
    });
    expect(t.html).not.toContain('<a href="https://fake.example">');
    expect(t.text).toContain('<a href="https://fake.example">x</a>');
  });
});
