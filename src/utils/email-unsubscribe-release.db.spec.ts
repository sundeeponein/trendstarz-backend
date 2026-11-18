import axios from "axios";
import { Types } from "mongoose";
import { releaseUnsubscribeBlock, setUnsubscribeReleaseDb } from "./email-unsubscribe-release";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.mock("axios");
const mocked = axios as jest.Mocked<typeof axios>;

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("lifting an unsubscribe block for an email the person asked for (real MongoDB)", () => {
  let tdb: TestDb;
  const db = () => tdb.conn.db as any;
  const blocked = [
    { email: "clicked@x.in", reason: { code: "unsubscribedViaEmail" } },
    { email: "bounced@x.in", reason: { code: "hardBounce" } },
    { email: "spam@x.in", reason: { code: "contactFlaggedAsSpam" } },
    { email: "stranger@x.in", reason: { code: "unsubscribedViaEmail" } },
    { email: "gone@x.in", reason: { code: "unsubscribedViaEmail" } },
  ];

  beforeAll(async () => {
    tdb = await startTestDb();
    setUnsubscribeReleaseDb(db());
    process.env.BREVO_API_KEY = "test-key";
  });
  afterAll(async () => {
    setUnsubscribeReleaseDb(null);
    delete process.env.BREVO_API_KEY;
    await tdb.stop();
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    mocked.get.mockResolvedValue({ data: { contacts: blocked } });
    mocked.delete.mockResolvedValue({ status: 204 });
    await db().collection("influencers").deleteMany({});
    await db().collection("influencers").insertMany([
      { _id: new Types.ObjectId(), email: "Clicked@X.in", offerEmailsOptOut: false },
      { email: "bounced@x.in" },
      { email: "spam@x.in" },
      { email: "gone@x.in", isDeleted: true },
    ]);
  });

  it("unblocks an account that only clicked Unsubscribe, and keeps promotions off", async () => {
    await expect(releaseUnsubscribeBlock(" clicked@x.in ")).resolves.toBe(true);
    expect(mocked.delete).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/blockedContacts/clicked%40x.in",
      expect.anything(),
    );
    const p = await db().collection("influencers").findOne({ email: "Clicked@X.in" });
    expect(p.offerEmailsOptOut).toBe(true);
  });

  it("never unblocks bounces, spam complaints, strangers or deleted accounts", async () => {
    for (const email of ["bounced@x.in", "spam@x.in", "stranger@x.in", "gone@x.in"]) {
      await expect(releaseUnsubscribeBlock(email)).resolves.toBe(false);
    }
    expect(mocked.delete).not.toHaveBeenCalled();
  });

  it("does nothing for an address that isn't blocked", async () => {
    await expect(releaseUnsubscribeBlock("fine@x.in")).resolves.toBe(false);
    expect(mocked.delete).not.toHaveBeenCalled();
  });

  it("never throws when Brevo is down — the email still goes out as before", async () => {
    mocked.get.mockRejectedValue(Object.assign(new Error("down"), { response: { status: 503 } }));
    await expect(releaseUnsubscribeBlock("clicked@x.in")).resolves.toBe(false);
  });
});
