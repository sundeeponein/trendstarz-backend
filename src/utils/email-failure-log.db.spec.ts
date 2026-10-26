jest.mock("./brevo-email.service", () => ({
  sendEmailBrevo: jest.fn(),
  DEFAULT_SENDER: "noreply@trendstarz.in",
}));
import { sendEmailBrevo } from "./brevo-email.service";
import { sendAppEmail, setEmailFailureCollection, EMAIL_FAILURES } from "./app-email.service";
import { runIntegrityChecks } from "../data-integrity/integrity-checks";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("failed emails are recorded (real MongoDB)", () => {
  let db: TestDb;
  const saved = process.env.BREVO_API_KEY;
  beforeAll(async () => {
    db = await startTestDb();
    setEmailFailureCollection(db.conn.db!.collection(EMAIL_FAILURES));
    process.env.BREVO_API_KEY = "test-key";
  });
  afterAll(async () => {
    setEmailFailureCollection(null);
    process.env.BREVO_API_KEY = saved;
    await db.stop();
  });

  it("records a refused send (no body), still throws to the caller, and Data health shows it", async () => {
    (sendEmailBrevo as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), { response: { status: 400, data: { code: "invalid_parameter", message: "email is not valid" } } }),
    );
    await expect(
      sendAppEmail({ to: " Asha@X.in ", subject: "Your TrendStarZ OTP", text: "secret 123456" }),
    ).rejects.toThrow("Request failed");

    const rows = await db.conn.db!.collection(EMAIL_FAILURES).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to: "asha@x.in", subject: "Your TrendStarZ OTP", error: "HTTP 400 invalid_parameter email is not valid" });
    expect(JSON.stringify(rows[0])).not.toContain("123456");

    (sendEmailBrevo as jest.Mock).mockResolvedValueOnce({ messageId: "m1" });
    await sendAppEmail({ to: "ok@x.in", subject: "Hi", text: "x" });
    expect(await db.conn.db!.collection(EMAIL_FAILURES).countDocuments()).toBe(1);

    const check = (await runIntegrityChecks(db.conn.db as any)).find((c) => c.key === "email_failures")!;
    expect(check.count).toBe(1);
    expect(check.samples[0]).toContain("as***@x.in · Your TrendStarZ OTP — HTTP 400");
  });
});
