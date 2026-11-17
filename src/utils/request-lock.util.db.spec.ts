import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  setRequestLockCollection,
  withRequestLocks,
} from "./request-lock.util";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("withRequestLocks (real MongoDB)", () => {
  let db: TestDb;
  const locks = () => db.conn.db!.collection("request_locks");
  const items = () => db.conn.db!.collection("lock_test_items");

  beforeAll(async () => {
    db = await startTestDb();
    setRequestLockCollection(locks());
  });
  afterAll(async () => {
    setRequestLockCollection(null);
    await db.stop();
  });
  beforeEach(async () => {
    await locks().deleteMany({});
    await items().deleteMany({});
  });

  /** The pattern every limit uses: count, (slow checks), then create. */
  async function countThenCreate(owner: string, limit: number) {
    const used = await items().countDocuments({ owner });
    await new Promise((r) => setTimeout(r, 30)); // plan lookups, validation…
    if (used >= limit) throw new BadRequestException("Plan limit reached");
    await items().insertOne({ owner });
  }

  it("without the lock, requests sent together pass the limit (the bug)", async () => {
    await Promise.allSettled(
      Array.from({ length: 6 }, () => countThenCreate("hostA", 3)),
    );
    expect(await items().countDocuments({ owner: "hostA" })).toBeGreaterThan(3);
  });

  it("with the lock, six requests sent together create exactly the limit", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        withRequestLocks(["slots:hostA"], () => countThenCreate("hostA", 3)),
      ),
    );
    expect(await items().countDocuments({ owner: "hostA" })).toBe(3);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(3);
    // The waiting requests get the normal limit message, not a "busy" error.
    for (const r of refused) expect(r.reason).toBeInstanceOf(BadRequestException);
    expect(await locks().countDocuments({})).toBe(0); // all released
  });

  it("different keys don't wait for each other", async () => {
    let running = 0;
    let maxRunning = 0;
    const job = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
    };
    await Promise.all([
      withRequestLocks(["slots:hostA"], job),
      withRequestLocks(["slots:hostB"], job),
    ]);
    expect(maxRunning).toBe(2);
  });

  it("keys asked for in different orders don't block each other forever", async () => {
    const done: string[] = [];
    await Promise.all([
      withRequestLocks(["x", "y"], async () => {
        await new Promise((r) => setTimeout(r, 30));
        done.push("a");
      }),
      withRequestLocks(["y", "x"], async () => {
        await new Promise((r) => setTimeout(r, 30));
        done.push("b");
      }),
    ]);
    expect(done.sort()).toEqual(["a", "b"]);
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withRequestLocks(["slots:hostA"], async () => {
        throw new BadRequestException("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await locks().countDocuments({})).toBe(0);
  });

  it("a lock left by a crashed request expires and is taken over", async () => {
    await locks().insertOne({
      _id: "slots:hostA" as any,
      owner: "crashed",
      lockedUntil: new Date(Date.now() - 1000),
    });
    await expect(
      withRequestLocks(["slots:hostA"], async () => "ran"),
    ).resolves.toBe("ran");
  });

  it("gives up with a clear message when the lock stays held", async () => {
    await locks().insertOne({
      _id: "slots:hostA" as any,
      owner: "other",
      lockedUntil: new Date(Date.now() + 60_000),
    });
    const err = await withRequestLocks(["slots:hostA"], async () => "ran", {
      waitMs: 300,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/try again/i);
    // Someone else's lock is left alone.
    expect(await locks().countDocuments({ owner: "other" })).toBe(1);
  });
});
