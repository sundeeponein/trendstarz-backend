import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getConnectionToken } from "@nestjs/mongoose";
import request from "supertest";
import { ClientErrorsController, CLIENT_ERRORS } from "./client-errors.controller";
import { runIntegrityChecks } from "./integrity-checks";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("browser errors are recorded (real HTTP + MongoDB)", () => {
  let db: TestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientErrorsController],
      providers: [{ provide: getConnectionToken(), useValue: db.conn }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  it("stores page, message and browser — ids and emails masked; empty reports ignored", async () => {
    await request(app.getHttpServer())
      .post("/client-errors")
      .send({ page: "/campaign/6a1d76a67b84284c4551789a?tab=1", name: "TypeError", message: "x is undefined for asha@x.in", browser: "Chrome 130" })
      .expect(204);
    await request(app.getHttpServer()).post("/client-errors").send({}).expect(204);
    const rows = await db.conn.db!.collection(CLIENT_ERRORS).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page: "/campaign/:id", name: "TypeError", message: "x is undefined for [email]", browser: "Chrome 130" });
  });

  it("Data health warns only from 5 a day", async () => {
    const byKey = async () => (await runIntegrityChecks(db.conn.db as any)).find((c) => c.key === "client_errors")!;
    expect((await byKey()).count).toBe(0); // 1 so far
    await db.conn.db!.collection(CLIENT_ERRORS).insertMany(
      Array.from({ length: 4 }, () => ({ at: new Date(), page: "/campaign/:id", message: "x is undefined for [email]" })),
    );
    const c = await byKey();
    expect(c.count).toBe(5);
    expect(c.samples[0]).toBe("/campaign/:id ×5 — x is undefined for [email]");
  });
});
