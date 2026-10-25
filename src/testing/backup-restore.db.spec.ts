import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId, Decimal128 } from "mongodb";
import { DB_TEST_TIMEOUT_MS } from "./mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** cron/exportDatabase.js → cron/restoreDatabase.js gives back the same data. */
describe("database backup and restore (real MongoDB)", () => {
  let rs: MongoMemoryReplSet;
  let client: MongoClient;
  const root = path.resolve(__dirname, "../..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ts-backup-"));

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    client = await new MongoClient(rs.getUri()).connect();
  });
  afterAll(async () => {
    await client?.close();
    await rs?.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const uriFor = (db: string) => rs.getUri().replace(/\/(\?|$)/, `/${db}$1`);

  it("restores records with exact types and unique indexes, and refuses a non-empty target", async () => {
    const src = client.db("source");
    const id = new ObjectId();
    const when = new Date("2026-10-24T10:00:00.123Z");
    await src.collection("influencers").insertOne({ _id: id, email: "a@x.in", createdAt: when, amountPaise: 49900, ratio: Decimal128.fromString("1.5"), tags: ["x"] });
    await src.collection("influencers").createIndex({ email: 1 }, { unique: true, name: "email_1" });
    await src.collection("campaigninvites").insertMany([{ influencerId: id }, { influencerId: id }]);

    const env = { ...process.env, MONGODB_URI: uriFor("source") };
    execFileSync("node", [path.join(root, "cron/exportDatabase.js")], { cwd: work, env, stdio: "pipe" });
    const file = path.join(work, "backups", fs.readdirSync(path.join(work, "backups"))[0]);

    const { restore } = require(path.join(root, "cron/restoreDatabase.js"));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await restore(uriFor("restored"), file, { apply: true, replace: false });
    log.mockRestore();

    const out = client.db("restored");
    const doc: any = await out.collection("influencers").findOne({ _id: id });
    expect(doc.createdAt).toEqual(when);
    expect(doc.amountPaise).toBe(49900);
    expect(doc.ratio.toString()).toBe("1.5");
    expect(await out.collection("campaigninvites").countDocuments()).toBe(2);
    const idx = await out.collection("influencers").indexes();
    expect(idx.find((i: any) => i.name === "email_1")).toMatchObject({ unique: true });

    await expect(restore(uriFor("restored"), file, { apply: true, replace: false })).rejects.toThrow("already has data");
  });
});
