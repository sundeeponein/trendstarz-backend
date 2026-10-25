import axios from "axios";
import type { Db } from "mongodb";

/** One address Brevo will not send to, as Brevo reports it. */
export interface BlockedContact {
  email: string;
  reason?: { code?: string; message?: string };
  blockedAt?: string;
}

export interface EmailBlockRow {
  email: string;
  role: string;
  accountId: string;
  reason: string;
  blockedAt: string;
}

export interface EmailBlocksResult {
  blockedInBrevo: number;
  /** Live accounts whose email Brevo refuses: no OTPs, invites, payment or security emails reach them. */
  accounts: EmailBlockRow[];
}

const ROLES: Array<[collection: string, role: string]> = [
  ["influencers", "influencer"],
  ["brands", "brand"],
  ["photographers", "photographer"],
  ["users", "admin"],
];
const PAGE = 100;
const MAX_PAGES = 50;

/** Brevo's whole blocked list (hard bounces, spam complaints, unsubscribes, admin blocks). */
export async function fetchBlockedContacts(apiKey: string): Promise<BlockedContact[]> {
  const all: BlockedContact[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get("https://api.brevo.com/v3/smtp/blockedContacts", {
      params: { limit: PAGE, offset: page * PAGE },
      headers: { "api-key": apiKey },
      timeout: 10000,
    });
    const rows: BlockedContact[] = res.data?.contacts || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** Live accounts whose email is on Brevo's blocked list (read-only). */
export async function matchEmailBlocks(db: Db, blocked: BlockedContact[]): Promise<EmailBlocksResult> {
  const byEmail = new Map(blocked.map((b) => [String(b.email || "").trim().toLowerCase(), b]));
  const result: EmailBlocksResult = { blockedInBrevo: blocked.length, accounts: [] };
  if (!byEmail.size) return result;
  for (const [collection, role] of ROLES) {
    const rows = await db
      .collection(collection)
      .find(
        { isDeleted: { $ne: true }, anonymized: { $ne: true }, email: { $type: "string" } },
        { projection: { email: 1 } },
      )
      .toArray();
    for (const a of rows as any[]) {
      const hit = byEmail.get(String(a.email).trim().toLowerCase());
      if (!hit) continue;
      result.accounts.push({
        email: String(a.email).trim().toLowerCase(),
        role,
        accountId: String(a._id),
        reason: String(hit.reason?.message || hit.reason?.code || "blocked"),
        blockedAt: String(hit.blockedAt || ""),
      });
    }
  }
  return result;
}
