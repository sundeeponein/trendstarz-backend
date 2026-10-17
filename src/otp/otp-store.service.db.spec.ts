import { HttpException } from "@nestjs/common";
import {
  MAX_VERIFY_ATTEMPTS,
  OtpStoreService,
  SEND_HOURLY_LIMIT,
} from "./otp-store.service";
import {
  OtpCodeSchema,
  OtpVerificationTokenSchema,
} from "../database/schemas/otp.schema";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("OtpStoreService (real MongoDB)", () => {
  let db: TestDb;
  let codes: any;
  let tokens: any;
  // Two instances over one database = two servers / before and after a restart.
  let serverA: OtpStoreService;
  let serverB: OtpStoreService;

  beforeAll(async () => {
    db = await startTestDb();
    codes = db.conn.model("OtpCode", OtpCodeSchema);
    tokens = db.conn.model("OtpVerificationToken", OtpVerificationTokenSchema);
    await Promise.all([codes.init(), tokens.init()]);
    serverA = new OtpStoreService(codes, tokens);
    serverB = new OtpStoreService(codes, tokens);
  });
  afterAll(() => db.stop());
  beforeEach(async () => {
    await Promise.all([codes.deleteMany({}), tokens.deleteMany({})]);
  });

  it("a code sent by one server verifies on another, and its token redeems once", async () => {
    const otp = await serverA.issueCode("98765 43210".replace(" ", ""));
    const res = await serverB.verifyCode("phone", "9876543210", otp);
    expect(res.ok).toBe(true);
    const token = (res as any).verificationToken;
    expect(await serverA.consumeVerificationToken("phone", "9876543210", token)).toBe(true);
    expect(await serverB.consumeVerificationToken("phone", "9876543210", token)).toBe(false);
  });

  it("stores only hashes, never the code or the token", async () => {
    const otp = await serverA.issueCode("a@b.com");
    const row: any = await codes.findOne({ key: "a@b.com" }).lean();
    expect(JSON.stringify(row)).not.toContain(otp);
    const res: any = await serverA.verifyCode("email", "A@B.com", otp);
    const t: any = await tokens.findOne({}).lean();
    expect(JSON.stringify(t)).not.toContain(res.verificationToken);
  });

  it("a code works once, even when verified twice at the same moment", async () => {
    const otp = await serverA.issueCode("x@y.com");
    const [r1, r2] = await Promise.all([
      serverA.verifyCode("email", "x@y.com", otp),
      serverB.verifyCode("email", "x@y.com", otp),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
  });

  it("a token for one phone number can't verify another", async () => {
    const otp = await serverA.issueCode("1111111111");
    const res: any = await serverA.verifyCode("phone", "1111111111", otp);
    expect(await serverA.consumeVerificationToken("phone", "2222222222", res.verificationToken)).toBe(false);
  });

  it("locks the code after too many wrong attempts", async () => {
    const otp = await serverA.issueCode("lock@x.com");
    const wrong = otp === "123456" ? "654321" : "123456";
    for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i++) {
      expect((await serverA.verifyCode("email", "lock@x.com", wrong)).ok).toBe(false);
    }
    await expect(serverB.verifyCode("email", "lock@x.com", wrong)).rejects.toBeInstanceOf(HttpException);
    // The right code no longer works either.
    expect((await serverA.verifyCode("email", "lock@x.com", otp)).ok).toBe(false);
  });

  it("rate-limits sends across servers (30s gap, hourly cap)", async () => {
    const t0 = new Date("2026-10-17T10:00:00Z");
    await serverA.issueCode("rate@x.com", t0);
    await expect(
      serverB.issueCode("rate@x.com", new Date(t0.getTime() + 5_000)),
    ).rejects.toBeInstanceOf(HttpException);
    for (let i = 1; i < SEND_HOURLY_LIMIT; i++) {
      await serverA.issueCode("rate@x.com", new Date(t0.getTime() + i * 60_000));
    }
    await expect(
      serverB.issueCode("rate@x.com", new Date(t0.getTime() + 30 * 60_000)),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it("an expired token is refused", async () => {
    const otp = await serverA.issueCode("exp@x.com");
    const res: any = await serverA.verifyCode("email", "exp@x.com", otp);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await serverA.consumeVerificationToken("email", "exp@x.com", res.verificationToken, later)).toBe(false);
  });
});
