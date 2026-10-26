jest.mock("../utils/app-email.service", () => ({ sendAppEmail: jest.fn(async () => ({})) }));
jest.mock("../utils/security-alert.util", () => ({
  sendSecurityAlert: jest.fn(),
  maskEmail: (e: string) => String(e).replace(/^(.{2}).*(@.*)$/, "$1***$2"),
}));
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { sendAppEmail } from "../utils/app-email.service";
import { AuthService } from "./auth.service";
import { OtpStoreService } from "../otp/otp-store.service";
import { OtpCodeSchema, OtpVerificationTokenSchema } from "../database/schemas/otp.schema";
import { UserSchema, InfluencerSchema, BrandSchema, PhotographerSchema } from "../database/schemas/profile.schemas";
import { getJwtSecret } from "./jwt-secret";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("admin two-step login (real MongoDB)", () => {
  let db: TestDb;
  let auth: any;
  const saved = process.env.ADMIN_2FA;

  beforeAll(async () => {
    db = await startTestDb();
    const User = db.conn.model("User", UserSchema, "users");
    const otp = new OtpStoreService(
      db.conn.model("OtpCode", OtpCodeSchema, "otp_codes") as any,
      db.conn.model("OtpVerificationToken", OtpVerificationTokenSchema, "otp_verification_tokens") as any,
    );
    auth = Object.assign(Object.create(AuthService.prototype), {
      userModel: User,
      influencerModel: db.conn.model("Influencer", InfluencerSchema, "influencers"),
      brandModel: db.conn.model("Brand", BrandSchema, "brands"),
      photographerModel: db.conn.model("Photographer", PhotographerSchema, "photographers"),
      otpStore: otp,
    });
    await db.conn.collection("users").insertOne({ email: "boss@x.in", name: "Boss", role: "admin", password: await bcrypt.hash("Admin#Pass1", 10) });
  });
  afterAll(async () => {
    process.env.ADMIN_2FA = saved;
    await db.stop();
  });

  const codeFromEmail = () => {
    const calls = (sendAppEmail as jest.Mock).mock.calls;
    return String(calls[calls.length - 1][0].text).match(/\b(\d{6})\b/)![1];
  };
  // The code store allows one send per 30s per address; each test starts fresh.
  const step1 = async () => {
    await db.conn.collection("otp_codes").deleteMany({});
    return (auth as any).loginChecked("boss@x.in", "Admin#Pass1", undefined, {});
  };

  it("the password alone gives a code by email and a challenge — never a session", async () => {
    const r = await step1();
    expect(r).toMatchObject({ twoFactorRequired: true, sentTo: "bo***@x.in" });
    expect(r.token).toBeUndefined();
    expect((jwt.verify(r.challenge, getJwtSecret()) as any).purpose).toBe("admin_login_2fa"); // the guard refuses purpose tokens
    expect(sendAppEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "boss@x.in" }));
  });

  it("the right code gives the session; a wrong code doesn't", async () => {
    const r = await step1();
    await expect(auth.verifyAdminLoginCode(r.challenge, "000000")).rejects.toThrow();
    const ok = await auth.verifyAdminLoginCode(r.challenge, codeFromEmail());
    expect(ok.token).toBeTruthy();
    expect(ok.user).toMatchObject({ email: "boss@x.in", role: "admin" });
  });

  it("a code can't be reused, and a forged or expired challenge is refused", async () => {
    const r = await step1();
    const code = codeFromEmail();
    await auth.verifyAdminLoginCode(r.challenge, code);
    await expect(auth.verifyAdminLoginCode(r.challenge, code)).rejects.toThrow();
    const forged = jwt.sign({ purpose: "admin_login_2fa", adminId: "x", email: "boss@x.in" }, "not-the-secret");
    await expect(auth.verifyAdminLoginCode(forged, code)).rejects.toThrow(/expired/);
  });

  it("ADMIN_2FA=off is the escape hatch: the password logs straight in", async () => {
    process.env.ADMIN_2FA = "off";
    const r = await step1();
    expect(r.token).toBeTruthy();
    process.env.ADMIN_2FA = saved;
  });
});
