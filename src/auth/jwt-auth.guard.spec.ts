import * as jwt from "jsonwebtoken";
import {
  JwtAuthGuard,
  getJwtAuthGuardAccountStatusMetrics,
  invalidateAccountStatusCache,
} from "./jwt-auth.guard";
import { getJwtSecret } from "./jwt-secret";

describe("JwtAuthGuard account-status check", () => {
  const ORIGINAL_ENV = process.env;
  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JWT_SECRET: ORIGINAL_ENV.JWT_SECRET || "test-secret",
    };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  let seq = 0;
  const freshId = () => `64b00000000000000000${String(++seq).padStart(4, "0")}`;

  function context(token: string) {
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    return {
      req,
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => () => undefined,
        getClass: () => class {},
      } as any,
    };
  }

  function modelReturning(doc: any) {
    const exec = jest.fn().mockResolvedValue(doc);
    const chain = {
      select: jest.fn(),
      maxTimeMS: jest.fn(),
      lean: jest.fn(),
      exec,
    };
    chain.select.mockReturnValue(chain);
    chain.maxTimeMS.mockReturnValue(chain);
    chain.lean.mockReturnValue(chain);
    return { findById: jest.fn(() => chain), chain };
  }

  function guardWith(
    models: Record<string, any>,
    allowPendingDeletion = false,
  ) {
    const reflector = {
      getAllAndOverride: jest.fn(() => allowPendingDeletion),
    };
    return new JwtAuthGuard(reflector as any, { models } as any);
  }

  const sign = (payload: any) => jwt.sign(payload, getJwtSecret());

  it("reads the account from Nest's injected connection, then serves it from cache", async () => {
    const id = freshId();
    const influencer = modelReturning({ isDeleted: false, status: "accepted" });
    const guard = guardWith({ Influencer: influencer });
    const token = sign({ userId: id, role: "influencer" });

    await expect(guard.canActivate(context(token).ctx)).resolves.toBe(true);
    expect(influencer.findById).toHaveBeenCalledWith(id);
    expect(influencer.chain.select).toHaveBeenCalledWith("isDeleted status");

    await expect(guard.canActivate(context(token).ctx)).resolves.toBe(true);
    expect(influencer.findById).toHaveBeenCalledTimes(1); // cached for 60s
    invalidateAccountStatusCache(id);
  });

  it("blocks a deleted account (this check never ran before the fix)", async () => {
    const id = freshId();
    const guard = guardWith({
      Brand: modelReturning({ isDeleted: true, status: "deleted" }),
    });
    await expect(
      guard.canActivate(context(sign({ userId: id, role: "brand" })).ctx),
    ).rejects.toThrow("Your account has been deleted");
    invalidateAccountStatusCache(id);
  });

  it("lets a deletion-pending account reach endpoints that allow it", async () => {
    const id = freshId();
    const guard = guardWith(
      {
        Photographer: modelReturning({
          isDeleted: true,
          status: "deletion_pending",
        }),
      },
      true,
    );
    await expect(
      guard.canActivate(
        context(sign({ userId: id, role: "photographer" })).ctx,
      ),
    ).resolves.toBe(true);
    invalidateAccountStatusCache(id);
  });

  it("skips the lookup for admins", async () => {
    const influencer = modelReturning({});
    const guard = guardWith({ Influencer: influencer });
    await expect(
      guard.canActivate(
        context(sign({ userId: freshId(), role: "admin" })).ctx,
      ),
    ).resolves.toBe(true);
    expect(influencer.findById).not.toHaveBeenCalled();
  });

  it("allows the request when the model isn't on the connection (no lookup possible)", async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(
        context(sign({ userId: freshId(), role: "influencer" })).ctx,
      ),
    ).resolves.toBe(true);
  });

  it("still fails open after 1.5s if the database doesn't answer", async () => {
    jest.useFakeTimers();
    const err = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const hanging = modelReturning(null);
      hanging.chain.exec.mockReturnValue(new Promise(() => undefined));
      const guard = guardWith({ Influencer: hanging });
      const before = getJwtAuthGuardAccountStatusMetrics().timeouts;
      const result = guard.canActivate(
        context(sign({ userId: freshId(), role: "influencer" })).ctx,
      );
      await jest.advanceTimersByTimeAsync(1600);
      await expect(result).resolves.toBe(true);
      expect(getJwtAuthGuardAccountStatusMetrics().timeouts).toBe(before + 1);
    } finally {
      err.mockRestore();
      jest.useRealTimers();
    }
  });

  it("rejects a missing or invalid token before any lookup", async () => {
    const influencer = modelReturning({});
    const guard = guardWith({ Influencer: influencer });
    const noHeader = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as any;
    await expect(guard.canActivate(noHeader)).rejects.toThrow(
      "No token provided",
    );
    await expect(guard.canActivate(context("not-a-jwt").ctx)).rejects.toThrow(
      "Invalid token",
    );
    expect(influencer.findById).not.toHaveBeenCalled();
  });
});
