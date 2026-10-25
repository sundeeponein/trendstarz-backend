import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { DatabaseBackupService, encryptBackup } from "./database-backup.service";
import { DB_TEST_TIMEOUT_MS } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

const KEY = "0f".repeat(32);
const crypto = require(path.resolve(__dirname, "../../cron/lib/backup-crypto.js"));

describe("backup encryption", () => {
  it("what the server encrypts, the restore script decrypts; a wrong key or a changed byte is refused", () => {
    const plain = Buffer.from("hello backup");
    const enc = encryptBackup(plain, KEY);
    expect(crypto.isEncryptedBackup(enc)).toBe(true);
    expect(crypto.decryptBackup(enc, KEY).toString()).toBe("hello backup");
    expect(() => crypto.decryptBackup(enc, "1e".repeat(32))).toThrow();
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 1;
    expect(() => crypto.decryptBackup(tampered, KEY)).toThrow();
    expect(() => encryptBackup(plain, "short")).toThrow("64 hex");
  });
});

describe("nightly backup → restore (real MongoDB)", () => {
  let rs: MongoMemoryReplSet;
  let client: MongoClient;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ts-nightly-"));
  const uriFor = (db: string) => rs.getUri().replace(/\/(\?|$)/, `/${db}$1`);

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    client = await new MongoClient(rs.getUri()).connect();
  });
  afterAll(async () => {
    await client?.close();
    await rs?.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("the encrypted nightly file restores to identical data", async () => {
    const src = client.db("live");
    const id = new ObjectId();
    const when = new Date("2026-10-25T04:15:00.000Z");
    await src.collection("payments").insertOne({ _id: id, amountPaise: 49900, at: when });
    await src.collection("payments").createIndex({ at: 1 }, { name: "at_1" });

    const service = new DatabaseBackupService({ db: src } as any);
    const { gz, records } = await service.buildExport();
    expect(records).toBe(1);
    const file = path.join(work, "nightly.json.gz.enc");
    fs.writeFileSync(file, encryptBackup(gz, KEY));

    process.env.BACKUP_ENCRYPTION_KEY = KEY;
    const { restore } = require(path.resolve(__dirname, "../../cron/restoreDatabase.js"));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await restore(uriFor("restored"), file, { apply: true, replace: false });
    log.mockRestore();
    const doc: any = await client.db("restored").collection("payments").findOne({ _id: id });
    expect(doc).toMatchObject({ amountPaise: 49900, at: when });
    expect((await client.db("restored").collection("payments").indexes()).some((i: any) => i.name === "at_1")).toBe(true);
  });
});

describe("keeping 14 days of backups", () => {
  it("deletes only files older than 14 days, and always keeps the newest 3", async () => {
    const now = new Date("2026-11-30T00:00:00Z");
    const day = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();
    const service: any = new DatabaseBackupService({} as any);
    const deleted: string[] = [];
    service.listFiles = async () => [1, 2, 20, 30].map((d) => ({ public_id: `f${d}`, created_at: day(d), bytes: 1 }));
    service.cloud = () => ({ api: { delete_resources: async (ids: string[]) => deleted.push(...ids) } });
    expect(await service.pruneOld(now)).toBe(1);
    expect(deleted).toEqual(["f30"]); // f20 is old but one of the newest 3
  });
});

describe("uploading the backup", () => {
  it("falls back to a private file when Cloudinary refuses an authenticated one (403)", async () => {
    const service: any = new DatabaseBackupService({} as any);
    const tried: string[] = [];
    service.cloud = () => ({
      uploader: {
        upload_stream: (opts: any, cb: any) => ({
          end: () => {
            tried.push(opts.type);
            if (opts.type === "authenticated") cb({ error: { message: "Forbidden", http_code: 403 } });
            else cb(null, { public_id: `system/db-backups/${opts.public_id}` });
          },
        }),
      },
    });
    const res = await service.uploadPrivate(Buffer.from("x"), "f.enc");
    expect(tried).toEqual(["authenticated", "private"]);
    expect(res).toMatchObject({ deliveryType: "private" });
  });
});
