import { derivePlatformKey as tsDerivePlatformKey } from "./social-account.util";
import { CANONICAL_TIERS as TS_TIERS } from "./tier-ranges.util";

// The backfill runs as a plain-node cron script; its planning logic lives in a
// CommonJS module so it can be tested here without a database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../cron/lib/socialAccountIdentity");

// ── Tiny in-memory Mongo stand-in (only what the script uses) ───────────────
function getPath(doc: any, path: string) {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}
function setPath(doc: any, path: string, value: any) {
  const keys = path.split(".");
  let cur = doc;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys[keys.length - 1]] = value;
}
function matches(doc: any, filter: any) {
  return Object.entries(filter).every(([path, cond]: [string, any]) => {
    const v = path === "_id" ? doc._id : getPath(doc, path);
    const norm = (x: any) => (x === undefined ? null : x);
    if (cond && typeof cond === "object" && "$in" in cond)
      return cond.$in.map(norm).includes(norm(v));
    if (cond && typeof cond === "object" && "$exists" in cond)
      return (v !== undefined) === cond.$exists;
    return norm(v) === norm(cond);
  });
}
function fakeDb(data: Record<string, any[]>) {
  const writes: any[] = [];
  return {
    writes,
    databaseName: "testdb",
    collection(name: string) {
      const docs = (data[name] ||= []);
      return {
        find: (filter: any) => ({
          toArray: () =>
            Promise.resolve(
              JSON.parse(
                JSON.stringify(
                  docs.filter(
                    (d) =>
                      !filter ||
                      !filter["socialMedia.0"] ||
                      (Array.isArray(d.socialMedia) && d.socialMedia.length),
                  ),
                ),
              ),
            ),
        }),
        updateOne: (filter: any, update: any) => {
          writes.push({ name, filter, update });
          const doc = docs.find((d) => matches(d, filter));
          if (!doc) return Promise.resolve({ modifiedCount: 0 });
          for (const [p, v] of Object.entries(update.$set || {}))
            setPath(doc, p, v);
          return Promise.resolve({ modifiedCount: 1 });
        },
      };
    },
  };
}

let idCounter = 0;
async function runScript(db: any, args: string[]) {
  const argv = process.argv;
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  process.env.MONGODB_URI = "mongodb://in-memory-test";
  try {
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        jest.doMock("mongoose", () => ({
          connect: jest.fn().mockResolvedValue(undefined),
          connection: { db },
          disconnect: jest.fn(() => {
            resolve();
            return Promise.resolve();
          }),
          Types: {
            ObjectId: class {
              toHexString() {
                return `aaaaaaaaaaaaaaaaaaaa${String(++idCounter).padStart(4, "0")}`;
              }
            },
          },
        }));
        process.argv = ["node", "backfillSocialAccountIdentity.js", ...args];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../cron/backfillSocialAccountIdentity.js");
      });
    });
    return log.mock.calls.map((c) => c.join(" ")).join("\n");
  } finally {
    process.argv = argv;
    log.mockRestore();
  }
}

const EXISTING_ID = "64b0000000000000000000a1";
function seed() {
  return {
    influencers: [
      {
        _id: "inf1",
        socialMedia: [
          {
            platform: "Instagram",
            handle: "one",
            tier: "Nano",
            followersCount: 0,
            contentTypes: [{ name: "Reel", price: 5 }],
          },
          {
            platform: "YouTube",
            handle: "ch",
            tier: "Macro",
            followersCount: 0,
            socialAccountId: EXISTING_ID,
            platformKey: "youtube",
          },
          {
            platform: "X / Twitter",
            handle: "xx",
            tier: "Starter",
            followersCount: 0,
          },
        ],
      },
      {
        _id: "inf2",
        socialMedia: [
          {
            platform: "Pinterest",
            handle: "pin",
            tier: "Mid tier",
            followersCount: 0,
            socialAccountId: "not-an-id",
          },
        ],
      },
      { _id: "inf3", socialMedia: [] },
    ],
    photographers: [
      {
        _id: "ph1",
        socialMedia: [
          {
            platform: "Instagram",
            handle: "shoot",
            tier: "Micro",
            followersCount: 0,
          },
        ],
      },
    ],
    brands: [],
    tiers: [
      { _id: "t1", name: "Starter", desc: "1-100", showInFrontend: false },
      {
        _id: "t2",
        name: "Mega / Celebrity",
        desc: "1,000,001+",
        showInFrontend: true,
        key: "custom",
      },
      { _id: "t3", name: "Gold", desc: "?" },
    ],
  };
}

describe("social account identity backfill (Stage 3A-0)", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe("stays in sync with the backend definitions", () => {
    it("derives the same platform keys", () => {
      for (const name of [
        "Instagram",
        "YouTube",
        "Facebook",
        "LinkedIn",
        "X / Twitter",
        "Twitter",
        "TikTok",
        "Pinterest Pro",
        " x ",
      ]) {
        expect(lib.derivePlatformKey(name)).toBe(tsDerivePlatformKey(name));
      }
    });

    it("uses the same canonical tiers", () => {
      expect(lib.CANONICAL_TIERS).toEqual(TS_TIERS.map((t) => ({ ...t })));
    });
  });

  describe("planning", () => {
    it("plans only missing fields, reports invalid ids and unknown platforms, and never plans other fields", () => {
      const next = (() => {
        let n = 0;
        return () => `bbbbbbbbbbbbbbbbbbbb${String(++n).padStart(4, "0")}`;
      })();
      const { changes, report } = lib.planProfile(seed().influencers[0], next);
      expect(report).toMatchObject({
        entries: 3,
        missingId: 2,
        missingKey: 2,
        invalidId: 0,
        ambiguousPlatforms: [],
      });
      expect(changes).toEqual([
        {
          index: 0,
          snapshot: { platform: "Instagram", handle: "one" },
          set: {
            socialAccountId: "bbbbbbbbbbbbbbbbbbbb0001",
            platformKey: "instagram",
          },
        },
        {
          index: 2,
          snapshot: { platform: "X / Twitter", handle: "xx" },
          set: {
            socialAccountId: "bbbbbbbbbbbbbbbbbbbb0002",
            platformKey: "x",
          },
        },
      ]);
      const other = lib.planProfile(seed().influencers[1], next);
      expect(other.report).toMatchObject({
        invalidId: 1,
        missingId: 0,
        ambiguousPlatforms: ["Pinterest"],
      });
      expect(other.changes[0].set).toEqual({ platformKey: "pinterest" });
    });

    it("guards each write with the entry snapshot, so an entry edited meanwhile is skipped", () => {
      const doc = seed().influencers[0];
      const [change] = lib.planProfile(
        doc,
        () => "cccccccccccccccccccccccc",
      ).changes;
      const { filter } = lib.toUpdate("inf1", change);
      expect(matches(doc, filter)).toBe(true);
      doc.socialMedia[0].handle = "renamed-by-creator";
      expect(matches(doc, filter)).toBe(false);
    });

    it("finds duplicate ids across profiles", () => {
      expect(
        lib.findDuplicateIds([
          { socialMedia: [{ socialAccountId: EXISTING_ID }] },
          { socialMedia: [{ socialAccountId: EXISTING_ID }] },
        ]),
      ).toEqual([{ socialAccountId: EXISTING_ID, count: 2 }]);
    });

    it("plans only missing tier bounds and never touches existing values", () => {
      const { changes, unknown } = lib.planTiers(seed().tiers);
      expect(changes).toEqual([
        {
          _id: "t1",
          name: "Starter",
          set: { key: "starter", minFollowers: 1, maxFollowers: 100 },
        },
        {
          _id: "t2",
          name: "Mega / Celebrity",
          set: { minFollowers: 1000001, maxFollowers: null },
        },
      ]);
      expect(unknown).toEqual(["Gold"]);
    });
  });

  describe("running the script", () => {
    it("dry run makes no writes", async () => {
      const data = seed();
      const before = JSON.stringify(data);
      const db = fakeDb(data);
      const out = await runScript(db, []);
      expect(db.writes).toHaveLength(0);
      expect(JSON.stringify(data)).toBe(before);
      expect(out).toContain("(DRY RUN)");
      expect(out).toContain('"missingId":2');
      expect(out).toContain("dry run — nothing written");
    });

    it("--dry-run also makes no writes", async () => {
      const db = fakeDb(seed());
      await runScript(db, ["--dry-run"]);
      expect(db.writes).toHaveLength(0);
    });

    it("apply adds only the missing identity fields and tier bounds", async () => {
      const data = seed();
      const original = JSON.parse(JSON.stringify(data));
      const db = fakeDb(data);
      await runScript(db, ["--apply"]);

      const [ig, yt, x] = data.influencers[0].socialMedia as any[];
      expect(ig).toMatchObject({ platformKey: "instagram" });
      expect(lib.isSocialAccountId(ig.socialAccountId)).toBe(true);
      expect(x.platformKey).toBe("x");
      // Existing id untouched; invalid id reported, never overwritten.
      expect(yt.socialAccountId).toBe(EXISTING_ID);
      expect(
        (data.influencers[1].socialMedia as any[])[0].socialAccountId,
      ).toBe("not-an-id");
      expect((data.photographers[0].socialMedia as any[])[0].platformKey).toBe(
        "instagram",
      );

      // Nothing else changed on any entry.
      const strip = (e: any) => {
        const rest = { ...e };
        delete rest.socialAccountId;
        delete rest.platformKey;
        return rest;
      };
      for (const coll of ["influencers", "photographers"] as const) {
        (data[coll] as any[]).forEach((doc, i) =>
          doc.socialMedia.forEach((e: any, j: number) =>
            expect(strip(e)).toEqual(
              strip((original[coll] as any[])[i].socialMedia[j]),
            ),
          ),
        );
      }
      expect(data.tiers[0]).toMatchObject({
        key: "starter",
        minFollowers: 1,
        maxFollowers: 100,
        desc: "1-100",
        showInFrontend: false,
      });
      expect(data.tiers[1]).toMatchObject({
        key: "custom",
        minFollowers: 1000001,
        maxFollowers: null,
      });
      expect(data.tiers[2]).toEqual(original.tiers[2]);
    });

    it("a second apply changes nothing", async () => {
      const data = seed();
      await runScript(fakeDb(data), ["--apply"]);
      const afterFirst = JSON.stringify(data);
      const db2 = fakeDb(data);
      const out = await runScript(db2, ["--apply"]);
      expect(JSON.stringify(data)).toBe(afterFirst);
      expect(db2.writes).toHaveLength(0);
      expect(out).toContain('"missingId":0');
    });
  });
});
