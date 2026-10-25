import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import mongoose from "mongoose";
import { BrandSchema, InfluencerSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS } from "./mongo-replset.fixture-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require("../../cron/backfillPublicIds.js");

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("cron/backfillPublicIds.js (real MongoDB)", () => {
  let rs: MongoMemoryReplSet;
  let client: MongoClient;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    client = await new MongoClient(rs.getUri()).connect();
  });
  afterAll(async () => {
    await client?.close();
    await rs?.stop();
  });

  it("numbers old accounts oldest-first after the counter, never renumbering anyone", async () => {
    const db = client.db("ids");
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await db.collection("counters").insertOne({ _id: "influencer_public_id", seq: 446 } as any);
    const older = new ObjectId();
    const newer = new ObjectId();
    const numbered = new ObjectId();
    await db.collection("influencers").insertMany([
      { _id: newer, createdAt: new Date("2026-06-01") },
      { _id: older, createdAt: new Date("2026-04-19") },
      { _id: numbered, createdAt: new Date("2026-08-01"), publicId: "INF100300" },
    ]);
    await db.collection("brands").insertOne({ createdAt: new Date("2026-05-01"), publicId: null });

    expect(await script.run(db, { apply: false })).toMatchObject({ influencers: { missing: 2, assigned: 0 } });
    expect(await db.collection("influencers").countDocuments({ publicId: { $exists: true } })).toBe(1);

    await script.run(db, { apply: true });
    const id = async (col: string, _id: ObjectId) => ((await db.collection(col).findOne({ _id })) as any).publicId;
    expect(await id("influencers", older)).toBe("INF100447");
    expect(await id("influencers", newer)).toBe("INF100448");
    expect(await id("influencers", numbered)).toBe("INF100300");
    expect(((await db.collection("brands").findOne({})) as any).publicId).toBe("BRD100001"); // counter created on first use
    expect(((await db.collection("counters").findOne({ _id: "influencer_public_id" } as any)) as any).seq).toBe(448);

    expect(await script.run(db, { apply: true })).toMatchObject({ influencers: { missing: 0, assigned: 0 } }); // re-run is a no-op
    log.mockRestore();
  });

  it("any new account saved without a public ID gets the next one (e.g. the admin Firebase import)", async () => {
    const conn = await mongoose.createConnection(rs.getUri().replace(/\/(\?|$)/, "/hook$1")).asPromise();
    try {
      await conn.collection("counters").insertOne({ _id: "brand_public_id", seq: 13 } as any);
      const Brand = conn.model("Brand", BrandSchema, "brands");
      const Influencer = conn.model("Influencer", InfluencerSchema, "influencers");
      const imported: any = await new Brand({ email: "b@x.in", brandName: "B", password: "x", phoneNumber: "9876543210" }).save({ validateBeforeSave: false });
      expect(imported.publicId).toBe("BRD100014");
      const signedUp: any = await new Influencer({ email: "i@x.in", publicId: "INF100500" }).save({ validateBeforeSave: false });
      expect(signedUp.publicId).toBe("INF100500"); // sign-up's own ID is kept
      imported.brandName = "B2";
      await imported.save({ validateBeforeSave: false });
      expect(((await conn.collection("counters").findOne({ _id: "brand_public_id" } as any)) as any).seq).toBe(14); // updates don't take a number
    } finally {
      await conn.close();
    }
  });
});
