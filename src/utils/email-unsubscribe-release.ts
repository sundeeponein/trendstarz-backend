import axios from "axios";
import type { Db } from "mongodb";

/**
 * Brevo puts its own List-Unsubscribe header on every email, so Gmail shows an
 * "Unsubscribe" button even on login codes. One click — usually on an offer or
 * reactivation email — puts the address on Brevo's single blocked list, and from
 * then on no login code, password reset or payment email reaches it either
 * (seen 2026-11-18: 3 creators, all after promotional emails).
 *
 * When the person themselves asks for an email (a login code, a reset link, a
 * delete-account code), an unsubscribe must not stop it. So, before such a send:
 * if Brevo blocks the address ONLY because of an unsubscribe click, and it belongs
 * to a live account, we
 *   1. switch off promotional emails for that account (offerEmailsOptOut) — their
 *      "no more marketing" choice is kept, and
 *   2. unblock the address in Brevo, so this and later account emails arrive.
 * Bounces, spam complaints and admin blocks are never touched. Strangers (no
 * account) are never unblocked, so the public code form can't be used to undo
 * someone's unsubscribe.
 */
let db: Db | null = null;

/** Connected at startup (DataIntegrityService); until then nothing is released. */
export function setUnsubscribeReleaseDb(database: Db | null) {
  db = database;
}

/** Brevo's reason for a click on the email's own Unsubscribe link/button. */
export const UNSUBSCRIBE_CLICK_CODE = "unsubscribedViaEmail";

const ACCOUNT_COLLECTIONS = ["influencers", "brands", "photographers", "users"];
const PAGE = 100;
const MAX_PAGES = 20;

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function blockReason(apiKey: string, email: string): Promise<string | null> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get("https://api.brevo.com/v3/smtp/blockedContacts", {
      params: { limit: PAGE, offset: page * PAGE },
      headers: { "api-key": apiKey },
      timeout: 5000,
    });
    const rows: any[] = res.data?.contacts || [];
    const hit = rows.find((r) => String(r?.email || "").trim().toLowerCase() === email);
    if (hit) return String(hit.reason?.code || "blocked");
    if (rows.length < PAGE) return null;
  }
  return null;
}

/**
 * Returns true when the address was unblocked. Never throws: the email is sent
 * either way, exactly as before this existed.
 */
export async function releaseUnsubscribeBlock(to: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  const email = String(to || "").trim().toLowerCase();
  if (!db || !apiKey || !email) return false;
  try {
    if ((await blockReason(apiKey, email)) !== UNSUBSCRIBE_CLICK_CODE) return false;

    const match = {
      email: { $regex: `^\\s*${escapeRegex(email)}\\s*$`, $options: "i" },
      isDeleted: { $ne: true },
      anonymized: { $ne: true },
    };
    let accounts = 0;
    for (const name of ACCOUNT_COLLECTIONS) {
      const col = db.collection(name);
      if (!(await col.countDocuments(match, { limit: 1 }))) continue;
      accounts += 1;
      // Admin accounts get no promotional emails, so there is nothing to switch off.
      if (name !== "users") {
        await col.updateMany(match, { $set: { offerEmailsOptOut: true } });
      }
    }
    if (!accounts) return false;

    await axios.delete(`https://api.brevo.com/v3/smtp/blockedContacts/${encodeURIComponent(email)}`, {
      headers: { "api-key": apiKey },
      timeout: 5000,
    });
    console.info("[email] Unsubscribe block lifted for an account email it asked for; offer emails stay off.");
    return true;
  } catch (err: any) {
    // Status only — never the request (it carries the api-key header).
    console.warn(`[email] Could not check/lift an unsubscribe block: ${err?.response?.status || err?.code || "error"}`);
    return false;
  }
}
