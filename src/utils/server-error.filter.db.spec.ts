import { BadRequestException, Controller, Get, INestApplication, Param } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ServerErrorFilter, SERVER_ERRORS, setServerErrorCollection } from "./server-error.filter";
import { runIntegrityChecks } from "../data-integrity/integrity-checks";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

@Controller("demo")
class DemoController {
  @Get("crash/:id")
  crash(@Param("id") _id: string) {
    throw new Error("payout row missing for asha@x.in");
  }
  @Get("bad")
  bad() {
    throw new BadRequestException("Enter a UTR");
  }
}

describe("server errors are recorded (real HTTP + MongoDB)", () => {
  let db: TestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    setServerErrorCollection(db.conn.db!.collection(SERVER_ERRORS));
    const moduleRef = await Test.createTestingModule({ controllers: [DemoController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new ServerErrorFilter(app.getHttpAdapter()));
    await app.init();
  });
  afterAll(async () => {
    setServerErrorCollection(null);
    await app.close();
    await db.stop();
  });

  const waitFor = async (n: number) => {
    for (let i = 0; i < 40; i++) {
      if ((await db.conn.db!.collection(SERVER_ERRORS).countDocuments()) >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("records a crash (route pattern, no ids or emails) and leaves the response unchanged; 4xx is not recorded", async () => {
    const res = await request(app.getHttpServer()).get("/demo/crash/6a1d76a67b84284c4551789a");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: "Internal server error" }); // Nest's default answer
    await request(app.getHttpServer()).get("/demo/bad").expect(400);
    await waitFor(1);
    await new Promise((r) => setTimeout(r, 100));

    const rows = await db.conn.db!.collection(SERVER_ERRORS).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "GET", route: "/demo/crash/:id", status: 500, message: "payout row missing for [email]" });
    expect(JSON.stringify(rows[0])).not.toContain("6a1d76a6");

    const check = (await runIntegrityChecks(db.conn.db as any)).find((c) => c.key === "server_errors")!;
    expect(check.count).toBe(1);
    expect(check.samples[0]).toContain("GET /demo/crash/:id ×1");
  });
});
