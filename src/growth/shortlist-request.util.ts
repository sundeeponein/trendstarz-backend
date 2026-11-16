import { canonicalPhone } from "../utils/phone.util";

/**
 * "Get a creator shortlist" (growth plan move 2, 2026-11-16): a brand that has
 * no account yet tells us city, niche and budget; an admin WhatsApps them 5
 * matching creators within 24 hours.
 */

export const SHORTLIST_REQUESTS = "shortlist_requests";
export const SHORTLIST_STATUSES = ["new", "contacted", "converted", "closed"] as const;
export type ShortlistStatus = (typeof SHORTLIST_STATUSES)[number];

export const SHORTLIST_BUDGETS: Record<string, string> = {
  under_5k: "Under ₹5,000",
  "5k_20k": "₹5,000 – ₹20,000",
  "20k_50k": "₹20,000 – ₹50,000",
  "50k_plus": "₹50,000+",
  barter: "Free product / visit (no cash)",
  not_sure: "Not sure yet",
};

/** Requests are kept for a year, then removed (TTL index). */
export const SHORTLIST_KEEP_DAYS = 365;
/** A creator count is shown on the form only from this many, so small numbers stay private. */
export const MIN_COUNT_SHOWN = 20;

export interface ShortlistInput {
  name: string;
  businessName: string;
  phone: string;
  state: string;
  city: string;
  category: string;
  budget: string;
  note: string;
  attribution: { source: string; medium: string; campaign: string };
}

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Valid input, or the first problem in plain words. */
export function parseShortlistInput(body: any): { value?: ShortlistInput; error?: string } {
  const name = clean(body?.name, 80);
  const businessName = clean(body?.businessName, 100);
  const phone = canonicalPhone(body?.phone);
  const state = clean(body?.state, 60);
  const city = clean(body?.city, 60);
  const category = clean(body?.category, 60);
  const budget = String(body?.budget ?? "");
  const note = clean(body?.note, 500);
  if (name.length < 2) return { error: "Please add your name." };
  if (businessName.length < 2) return { error: "Please add your business name." };
  if (!/^[6-9]\d{9}$/.test(phone)) return { error: "Please add a 10-digit Indian mobile number (we'll WhatsApp you on it)." };
  if (!state) return { error: "Please choose your state." };
  if (!category) return { error: "Please choose the niche you want creators for." };
  if (!SHORTLIST_BUDGETS[budget]) return { error: "Please choose a budget." };
  const a = body?.attribution || {};
  return {
    value: {
      name,
      businessName,
      phone,
      state,
      city,
      category,
      budget,
      note,
      attribution: {
        source: clean(a.source, 40).toLowerCase(),
        medium: clean(a.medium, 40).toLowerCase(),
        campaign: clean(a.campaign, 80),
      },
    },
  };
}

// ── Signup link (2026-11-16) ──
// The shortlist WhatsApp ends with a brand signup link carrying "<requestId>.<code>".
// The code (random, stored on the request) lets the signup page prefill the
// brand's own details, and the finished signup marks the request converted.

/** Signup links work this long after the request. */
export const SIGNUP_LINK_DAYS = 60;

export function newSignupCode(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("crypto").randomBytes(16).toString("hex");
}

/** "<24-hex id>.<32-hex code>" → parts, or null. */
export function parseSignupRef(ref: unknown): { id: string; code: string } | null {
  const m = /^([a-f0-9]{24})\.([a-f0-9]{32})$/.exec(String(ref ?? "").trim());
  return m ? { id: m[1], code: m[2] } : null;
}

/**
 * After a brand signed up through a shortlist link: mark the request converted
 * and remember the brand. Best effort — never blocks the signup.
 */
export async function markShortlistSignup(db: any, ref: unknown, brandId: string): Promise<boolean> {
  const parts = parseSignupRef(ref);
  if (!parts || !db) return false;
  try {
    const { ObjectId } = require("mongodb");
    const now = new Date();
    const res = await db.collection(SHORTLIST_REQUESTS).updateOne(
      { _id: new ObjectId(parts.id), signupCode: parts.code, brandId: null },
      { $set: { status: "converted", brandId: String(brandId), signedUpAt: now, updatedAt: now } },
    );
    return res.modifiedCount > 0;
  } catch {
    return false;
  }
}
