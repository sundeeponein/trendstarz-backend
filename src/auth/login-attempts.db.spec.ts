import { LoginAttempts, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS, LOGIN_WINDOW_MS } from "./login-attempts.util";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("per-account login lock (real MongoDB)", () => {
  let db: TestDb;
  let attempts: LoginAttempts;
  beforeAll(async () => {
    db = await startTestDb();
    const col = (db.conn.db as any).collection("login_failures");
    await LoginAttempts.init(col);
    attempts = new LoginAttempts(col);
  });
  afterAll(async () => db?.stop());

  it(`locks one email after ${LOGIN_MAX_FAILURES} wrong passwords, only that email, until the lock ends`, async () => {
    const t0 = new Date("2026-10-24T10:00:00Z");
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await attempts.recordFailure("victim@x.in", new Date(t0.getTime() + i * 1000));
    await expect(attempts.assertNotLocked("victim@x.in", t0)).resolves.toBeUndefined();
    await attempts.recordFailure("victim@x.in", new Date(t0.getTime() + 20_000));
    await expect(attempts.assertNotLocked("victim@x.in", new Date(t0.getTime() + 30_000))).rejects.toThrow("Too many attempts");
    await expect(attempts.assertNotLocked("someone@x.in", new Date(t0.getTime() + 30_000))).resolves.toBeUndefined();
    await expect(
      attempts.assertNotLocked("victim@x.in", new Date(t0.getTime() + 20_000 + LOGIN_LOCK_MS + 1)),
    ).resolves.toBeUndefined();
  });

  it("old failures outside the window don't count, and a success clears the count", async () => {
    const t0 = new Date("2026-10-24T12:00:00Z");
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await attempts.recordFailure("slow@x.in", t0);
    const later = new Date(t0.getTime() + LOGIN_WINDOW_MS + 1000);
    await attempts.recordFailure("slow@x.in", later); // the 9 old ones expired
    await expect(attempts.assertNotLocked("slow@x.in", later)).resolves.toBeUndefined();
    await attempts.clear("slow@x.in");
    expect(await (db.conn.db as any).collection("login_failures").countDocuments({ _id: "slow@x.in" })).toBe(0);
  });
});
