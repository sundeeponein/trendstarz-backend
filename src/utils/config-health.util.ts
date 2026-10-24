import axios from "axios";
import { promises as dns } from "dns";
import { DEFAULT_SENDER } from "./brevo-email.service";
import Razorpay from "razorpay";
import { v2 as cloudinary } from "cloudinary";
import type { Connection } from "mongoose";

export type ConfigStatus = "working" | "missing" | "failing" | "off";

export interface ConfigCheck {
  service: string;
  status: ConfigStatus;
  /** What is missing or what went wrong — never a secret value. */
  detail: string;
}

const TIMEOUT_MS = 8000;

function missing(names: string[]): string[] {
  return names.filter((n) => !String(process.env[n] || "").trim());
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS)),
  ]);
}

/** A provider's error, reduced to its status/code — never the request or key. */
function reason(err: any): string {
  const status = err?.statusCode || err?.response?.status || err?.error?.http_code || err?.http_code;
  const code = err?.error?.code || err?.response?.data?.code || err?.code;
  return [status ? `HTTP ${status}` : "", code ? String(code) : "", !status && !code ? String(err?.message || "error") : ""]
    .filter(Boolean)
    .join(" ")
    .slice(0, 120);
}

async function check(
  service: string,
  required: string[],
  live?: () => Promise<unknown>,
  optional = false,
): Promise<ConfigCheck> {
  const absent = missing(required);
  if (absent.length) {
    return optional && absent.length === required.length
      ? { service, status: "off", detail: "Not set up (optional)" }
      : { service, status: "missing", detail: `Missing: ${absent.join(", ")}` };
  }
  if (!live) return { service, status: "working", detail: "Set (no live test available)" };
  try {
    await withTimeout(live());
    return { service, status: "working", detail: "Live test passed" };
  } catch (err) {
    return { service, status: "failing", detail: `Set, but the live test failed: ${reason(err)}` };
  }
}

/**
 * Admin check after a deploy or a key rotation: is each service configured, and
 * does its key actually work? Live tests are read-only calls.
 */
export async function runConfigChecks(connection?: Connection | null): Promise<ConfigCheck[]> {
  return Promise.all([
    check("Database (MongoDB)", ["MONGODB_URI"], async () => {
      if (!connection?.db) throw new Error("not connected");
      await connection.db.admin().ping();
    }),
    check("Login tokens (JWT_SECRET)", ["JWT_SECRET"], async () => {
      if (String(process.env.JWT_SECRET).length < 32) throw new Error("shorter than 32 characters");
    }),
    check("Razorpay payments", ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"], () =>
      new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID as string,
        key_secret: process.env.RAZORPAY_KEY_SECRET as string,
      }).orders.all({ count: 1 }),
    ),
    check("Razorpay payments webhook secret", ["RAZORPAY_PAYMENTS_WEBHOOK_SECRET"]),
    check("RazorpayX payouts", ["RAZORPAYX_KEY_ID", "RAZORPAYX_KEY_SECRET", "RAZORPAYX_ACCOUNT_NUMBER"], undefined, true),
    check("RazorpayX webhook secret", ["RAZORPAYX_WEBHOOK_SECRET"], undefined, true),
    check("Cloudinary (images)", ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"], () => {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      return cloudinary.api.ping();
    }),
    check("Brevo (emails)", ["BREVO_API_KEY"], async () => {
      try {
        await axios.get("https://api.brevo.com/v3/smtp/statistics/aggregatedReport", {
          params: { days: 1 },
          headers: { "api-key": process.env.BREVO_API_KEY as string },
          timeout: TIMEOUT_MS,
        });
      } catch (err: any) {
        // A key limited to sending may not read statistics: 403 still proves it's a real key.
        if (err?.response?.status === 403) return;
        throw err;
      }
    }),
    // The sender's domain must be verified in Brevo (DKIM), or OTPs, resets and
    // alerts land in spam. Checked live in DNS.
    (async (): Promise<ConfigCheck> => {
      const sender = String(process.env.BREVO_FROM || DEFAULT_SENDER).trim();
      const domain = sender.split("@")[1] || "";
      const service = `Email sender domain (${domain || "?"})`;
      try {
        const records = await withTimeout(
          Promise.any([
            dns.resolveCname(`brevo1._domainkey.${domain}`),
            dns.resolveTxt(`brevo1._domainkey.${domain}`),
            dns.resolveCname(`brevo2._domainkey.${domain}`),
          ]),
        );
        return records && (records as any[]).length
          ? { service, status: "working", detail: `Brevo DKIM found for ${domain}` }
          : { service, status: "failing", detail: `No Brevo DKIM for ${domain} — emails may go to spam` };
      } catch {
        return {
          service,
          status: "failing",
          detail: `No Brevo DKIM for ${domain} — emails may go to spam. Use an @trendstarz.in sender (BREVO_FROM) or authenticate ${domain} in Brevo.`,
        };
      }
    })(),
    check("Firebase (login/password reset)", ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"], async () => {
      const key = String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n");
      if (!key.includes("BEGIN PRIVATE KEY")) throw new Error("FIREBASE_PRIVATE_KEY is not a private key");
    }),
    check("Push notifications (VAPID)", ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"], undefined, true),
    check("Frontend link (FRONTEND_URL)", ["FRONTEND_URL"]),
  ]);
}
