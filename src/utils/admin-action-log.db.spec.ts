import { of, throwError, lastValueFrom } from "rxjs";
import { Reflector } from "@nestjs/core";
import { AdminActionInterceptor } from "./admin-action.interceptor";
import { ADMIN_ACTIONS, setAdminActionCollection } from "./admin-action-log.util";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("admin actions are recorded (real MongoDB)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    setAdminActionCollection(db.conn.db!.collection(ADMIN_ACTIONS));
  });
  afterAll(async () => {
    setAdminActionCollection(null);
    await db.stop();
  });

  const ctx = (req: any) =>
    ({
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as any;
  const reflector = { get: () => "set_premium" } as unknown as Reflector;
  // The log is written after the response, without blocking it: wait for it.
  const flush = async (expect = 1) => {
    for (let i = 0; i < 40; i++) {
      if ((await db.conn.db!.collection(ADMIN_ACTIONS).countDocuments()) >= expect) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("records who did what to which account after success — never secrets", async () => {
    const req = {
      user: { userId: "admin-7", role: "admin" },
      params: { id: "acc-1" },
      body: { isPremium: true, premiumDuration: "3m", type: "brand", temporaryPassword: "x1", images: [1, 2] },
    };
    await lastValueFrom(new AdminActionInterceptor(reflector).intercept(ctx(req), { handle: () => of({ ok: true }) }));
    await flush();
    const rows = await db.conn.db!.collection(ADMIN_ACTIONS).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      adminId: "admin-7",
      action: "set_premium",
      targetType: "brand",
      targetId: "acc-1",
      details: { isPremium: true, premiumDuration: "3m", type: "brand", images: "[2 items]" },
    });
    expect(JSON.stringify(rows[0])).not.toContain("x1");
  });

  it("records nothing when the action fails", async () => {
    const req = { user: { userId: "admin-7" }, params: { id: "acc-2" }, body: {} };
    await expect(
      lastValueFrom(new AdminActionInterceptor(reflector).intercept(ctx(req), { handle: () => throwError(() => new Error("no")) })),
    ).rejects.toThrow("no");
    await new Promise((r) => setTimeout(r, 300));
    expect(await db.conn.db!.collection(ADMIN_ACTIONS).countDocuments({ targetId: "acc-2" })).toBe(0);
  });
});
