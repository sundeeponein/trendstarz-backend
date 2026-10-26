import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";

describe("GET /api/health (uptime monitors)", () => {
  const withPing = (ping: () => Promise<unknown>) => new HealthController({ db: { admin: () => ({ ping }) } } as any);

  it("is ok only when the database answers", async () => {
    await expect(withPing(async () => ({ ok: 1 })).health()).resolves.toEqual({ status: "ok", db: "ok" });
  });

  it("answers 503 when the database fails or doesn't answer", async () => {
    await expect(withPing(async () => { throw new Error("down"); }).health()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new HealthController(undefined).health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("gives up after 3 seconds instead of hanging", async () => {
    jest.useFakeTimers();
    const pending = withPing(() => new Promise(() => undefined)).health();
    jest.advanceTimersByTime(3001);
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    jest.useRealTimers();
  });
});
