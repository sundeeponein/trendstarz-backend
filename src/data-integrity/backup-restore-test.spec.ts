import { gzipSync } from "zlib";
import { EJSON } from "bson";
import { ObjectId } from "mongodb";
import { encryptBackup, decryptBackup, inspectBackup } from "./database-backup.service";

const KEY = "b".repeat(64);
const file = (collections: Record<string, any[]>) =>
  encryptBackup(
    gzipSync(Buffer.from(EJSON.stringify({ database: "t", exportedAt: "x", collections, indexes: {} }, { relaxed: false }))),
    KEY,
  );

describe("backup restore test", () => {
  const good = file({ influencers: [{ _id: new ObjectId() }, { _id: new ObjectId() }], payments: [{ _id: new ObjectId() }] });

  it("reads a good backup back in full", () => {
    expect(inspectBackup(good, KEY, { records: 3 }, ["influencers", "payments"])).toEqual({ records: 3, collections: 2, problems: [] });
  });

  it("refuses an altered file and a wrong key", () => {
    const altered = Buffer.from(good);
    altered[altered.length - 1] ^= 1;
    expect(() => decryptBackup(altered, KEY)).toThrow();
    expect(() => inspectBackup(good, "c".repeat(64), {}, [])).toThrow();
    expect(() => inspectBackup(Buffer.from("not a backup"), KEY, {}, [])).toThrow(/Not an encrypted/);
  });

  it("reports records or collections that a restore would not get back", () => {
    const r = inspectBackup(good, KEY, { records: 5 }, ["influencers", "payments", "campaigns"]);
    expect(r.problems).toEqual(["holds 3 records, the backup run logged 5", "missing collections: campaigns"]);
  });
});
