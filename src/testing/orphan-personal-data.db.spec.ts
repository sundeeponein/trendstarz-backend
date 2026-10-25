import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { DB_TEST_TIMEOUT_MS } from "./mongo-replset.fixture-spec";
import { PERSONAL_TRACES } from "../users/personal-traces";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require("../../cron/orphanPersonalData.js");

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** cron/orphanPersonalData.js removes only what deleted/anonymized accounts left behind. */
describe("orphan personal data cleanup (real MongoDB)", () => {
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

  it("uses the same list as account deletion", () => {
    expect(script.PERSONAL_TRACES).toEqual(PERSONAL_TRACES);
  });

  it("reports by default, then deletes only rows of missing or anonymized accounts", async () => {
    const db = client.db("orphans");
    const live = new ObjectId();
    const anon = new ObjectId();
    const gone = new ObjectId();
    await db.collection("influencers").insertMany([{ _id: live }, { _id: anon, anonymized: true }]);
    const as = (id: ObjectId, t: string) => (t === "objectId" ? id : String(id));
    for (const [col, field, t] of PERSONAL_TRACES) {
      await db.collection(col).insertMany([live, anon, gone].map((id) => ({ [field]: as(id, t) })));
    }
    await db.collection("payments").insertOne({ userId: gone }); // financial: never touched
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);

    const report = await script.run(db, { apply: false });
    expect(report).toEqual({ found: PERSONAL_TRACES.length * 2, removed: 0 });
    expect(await db.collection("profile_flags").countDocuments()).toBe(3);

    await script.run(db, { apply: true });
    for (const [col, field, t] of PERSONAL_TRACES) {
      const left = (await db.collection(col).find({}).toArray()).map((r) => String(r[field]));
      expect({ col, left }).toEqual({ col, left: [String(as(live, t))] });
    }
    expect(await db.collection("payments").countDocuments()).toBe(1);
    log.mockRestore();
  });

  it("refuses a database with no accounts", async () => {
    const db = client.db("empty");
    await db.collection("profile_flags").insertOne({ userId: "x" });
    await expect(script.run(db, { apply: true })).rejects.toThrow(/No accounts found/);
    expect(await db.collection("profile_flags").countDocuments()).toBe(1);
  });
});
