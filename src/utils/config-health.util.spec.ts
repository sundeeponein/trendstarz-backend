jest.mock("razorpay", () => jest.fn().mockImplementation(() => ({ orders: { all: jest.fn().mockRejectedValue({ statusCode: 401, error: { code: "BAD_REQUEST_ERROR" } }) } })));
jest.mock("cloudinary", () => ({ v2: { config: jest.fn(), api: { ping: jest.fn().mockResolvedValue({ status: "ok" }) } } }));
jest.mock("dns", () => ({
  promises: {
    resolveCname: jest.fn(async (name: string) => {
      if (name.endsWith("._domainkey.trendstarz.in")) return ["b1.trendstarz-in.dkim.brevo.com"];
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    }),
    resolveTxt: jest.fn(async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); }),
  },
}));
jest.mock("./cloudinary-upload-test", () => ({ cloudinaryUploadTest: jest.fn().mockResolvedValue(undefined) }));
jest.mock("axios", () => ({ get: jest.fn().mockRejectedValue({ response: { status: 403 } }) }));

import { runConfigChecks } from "./config-health.util";
import { cloudinaryUploadTest } from "./cloudinary-upload-test";

describe("admin configuration check", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("reports missing settings, optional services as off, a rejected key as failing, and never the secret", async () => {
    process.env = {
      ...saved,
      MONGODB_URI: "mongodb://x",
      JWT_SECRET: "s".repeat(40),
      RAZORPAY_KEY_ID: "rzp_live_x",
      RAZORPAY_KEY_SECRET: "super-secret-value",
      CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
      BREVO_API_KEY: "xkeysib-x",
      FRONTEND_URL: "https://trendstarz.in",
    };
    for (const k of ["RAZORPAY_PAYMENTS_WEBHOOK_SECRET", "RAZORPAYX_KEY_ID", "RAZORPAYX_KEY_SECRET", "RAZORPAYX_ACCOUNT_NUMBER", "RAZORPAYX_WEBHOOK_SECRET", "FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]) delete process.env[k];
    const ping = jest.fn().mockResolvedValue({});
    const checks = await runConfigChecks({ db: { admin: () => ({ ping }) } } as any);
    const by = Object.fromEntries(checks.map((c) => [c.service, c]));
    expect(by["Database (MongoDB)"].status).toBe("working");
    expect(by["Razorpay payments"]).toMatchObject({ status: "failing" });
    expect(by["Razorpay payments"].detail).toContain("HTTP 401");
    expect(by["Razorpay payments webhook secret"]).toMatchObject({ status: "missing" });
    expect(by["RazorpayX payouts"].status).toBe("off");
    expect(by["Cloudinary (images)"].status).toBe("working");
    expect(by["Brevo (emails)"].status).toBe("working"); // send-only key: 403 on stats still proves the key
    expect(by["Firebase (login/password reset)"].status).toBe("missing");
    expect(JSON.stringify(checks)).not.toContain("super-secret-value");
    // Default sender is on the Brevo-verified domain.
    expect(by["Email sender domain (trendstarz.in)"].status).toBe("working");
  });

  it("flags a sender on a domain without Brevo DKIM (mail would go to spam)", async () => {
    process.env = { ...saved, BREVO_FROM: "noreply@trendstarz.com" };
    const checks = await runConfigChecks(null);
    const sender = checks.find((c) => c.service.startsWith("Email sender domain"));
    expect(sender).toMatchObject({ service: "Email sender domain (trendstarz.com)", status: "failing" });
  });

  it("flags Cloudinary as failing when a ping works but uploads are refused", async () => {
    process.env = { ...saved, CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" };
    (cloudinaryUploadTest as jest.Mock).mockRejectedValueOnce(new Error("upload refused, HTTP 403: Upload not allowed"));
    const checks = await runConfigChecks(null);
    const c = checks.find((x) => x.service === "Cloudinary (images)");
    expect(c).toMatchObject({ status: "failing" });
    expect(c?.detail).toContain("Upload not allowed");
  });
});
