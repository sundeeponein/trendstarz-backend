import * as bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { assertPasswordForEmailChange } from "./email-change.util";
import { InfluencerSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("changing the login email needs the current password (real MongoDB)", () => {
  let db: TestDb;
  let Influencer: any;
  const withPassword = new Types.ObjectId();
  const noPassword = new Types.ObjectId();

  beforeAll(async () => {
    db = await startTestDb();
    Influencer = db.conn.model("Influencer", InfluencerSchema, "influencers");
    await db.conn.collection("influencers").insertMany([
      { _id: withPassword, email: "a@x.in", password: await bcrypt.hash("Right#Pass1", 10) },
      { _id: noPassword, email: "g@x.in" },
    ]);
  });
  afterAll(() => db.stop());

  it("accepts the right password, refuses a missing or wrong one", async () => {
    await expect(assertPasswordForEmailChange(Influencer, String(withPassword), "Right#Pass1")).resolves.toBeUndefined();
    await expect(assertPasswordForEmailChange(Influencer, String(withPassword), "")).rejects.toThrow(/Enter your current password/);
    await expect(assertPasswordForEmailChange(Influencer, String(withPassword), "wrong")).rejects.toThrow(/incorrect/);
  });

  it("tells accounts without a password to set one first", async () => {
    await expect(assertPasswordForEmailChange(Influencer, String(noPassword), "anything")).rejects.toThrow(/Forgot password first/);
  });

  it("is skipped for the local development bypass only", async () => {
    await expect(assertPasswordForEmailChange(Influencer, String(withPassword), "", true)).resolves.toBeUndefined();
  });
});
