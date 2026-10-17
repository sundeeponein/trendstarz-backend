import {
  claimCronLock,
  MIN_HOLD_MS,
  releaseCronLock,
  setCronLockCollection,
  SingleInstance,
} from "./single-instance";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("@SingleInstance job locks (real MongoDB)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    setCronLockCollection(db.conn.db!.collection("cron_locks"));
  });
  afterAll(async () => {
    setCronLockCollection(null);
    await db.stop();
  });
  beforeEach(() => db.conn.db!.collection("cron_locks").deleteMany({}));

  it("two copies firing at the same moment: only one runs the job", async () => {
    let runs = 0;
    class Jobs {
      @SingleInstance({ name: "test.sameMoment" })
      async job() {
        runs++;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const a = new Jobs();
    const b = new Jobs(); // a second copy of the app
    await Promise.all([a.job(), b.job(), a.job()]);
    expect(runs).toBe(1);
  });

  it("a copy firing a few seconds later still skips; the next scheduled run goes ahead", async () => {
    const t0 = new Date("2026-10-17T10:00:00Z");
    expect(await claimCronLock("test.later", 60_000, "copyA", t0)).toBe(true);
    await releaseCronLock("test.later", t0, "copyA", new Date(t0.getTime() + 1_000)); // job took 1s
    // Copy B's clock fires 5s late — the lease is still held for MIN_HOLD_MS.
    expect(await claimCronLock("test.later", 60_000, "copyB", new Date(t0.getTime() + 5_000))).toBe(false);
    // Next schedule (e.g. 5 minutes later): either copy may run it.
    expect(await claimCronLock("test.later", 60_000, "copyB", new Date(t0.getTime() + MIN_HOLD_MS + 240_000))).toBe(true);
  });

  it("a crashed copy's lease expires, so the job isn't stuck forever", async () => {
    const t0 = new Date("2026-10-17T10:00:00Z");
    expect(await claimCronLock("test.crash", 10 * 60_000, "dead", t0)).toBe(true); // never released
    expect(await claimCronLock("test.crash", 10 * 60_000, "alive", new Date(t0.getTime() + 60_000))).toBe(false);
    expect(await claimCronLock("test.crash", 10 * 60_000, "alive", new Date(t0.getTime() + 11 * 60_000))).toBe(true);
  });

  it("still releases (and keeps 'this') when the job throws", async () => {
    class Jobs {
      calls = 0;
      @SingleInstance({ name: "test.throws" })
      async job() {
        this.calls++;
        throw new Error("job failed");
      }
    }
    const j = new Jobs();
    await expect(j.job()).rejects.toThrow("job failed");
    expect(j.calls).toBe(1);
    const lease: any = await db.conn.db!.collection("cron_locks").findOne({ _id: "test.throws" } as any);
    expect(lease.finishedAt).toBeInstanceOf(Date);
  });
});

describe("@SingleInstance without a database (unit tests)", () => {
  it("just runs the job", async () => {
    setCronLockCollection(null);
    class Jobs {
      @SingleInstance()
      async job() {
        return "ran";
      }
    }
    await expect(new Jobs().job()).resolves.toBe("ran");
  });
});
