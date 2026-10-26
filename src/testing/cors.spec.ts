import { INestApplication, Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

/** Mirrors main.ts: other sites get no CORS headers (browser blocks), never a 500. */
@Controller("ping")
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe("CORS", () => {
  let app: INestApplication;
  const allowed = ["https://trendstarz.in", "https://www.trendstarz.in"];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const fs = require("fs");
    const main = fs.readFileSync(require("path").join(__dirname, "..", "main.ts"), "utf8");
    // Guard against the old behaviour coming back.
    expect(main).not.toMatch(/new Error\("Not allowed by CORS"\)/);
    app.enableCors({
      origin: (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) =>
        !origin ? cb(null, true) : cb(null, allowed.includes(origin)),
      credentials: true,
    });
    await app.init();
  });
  afterAll(() => app.close());

  it("allows the site, blocks other origins without a server error", async () => {
    const ok = await request(app.getHttpServer()).options("/ping").set("Origin", "https://trendstarz.in").set("Access-Control-Request-Method", "POST");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://trendstarz.in");
    const evil = await request(app.getHttpServer()).options("/ping").set("Origin", "https://evil.example.com").set("Access-Control-Request-Method", "POST");
    expect(evil.status).toBeLessThan(500);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
