import axios from "axios";
import { ObjectId, type Db } from "mongodb";
import { openMoneyFilter, openWorkFilter } from "../users/self-deletion.util";

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
  /** A campaign is under way with them (same rule as the self-delete guard). */
  openWork: boolean;
  /** A payment, payout or refund involving them isn't settled. */
  openMoney: boolean;
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
        openWork: false,
        openMoney: false,
      });
    }
  }
  // Their payment and campaign emails aren't arriving: flag who has something
  // open, so the admin unblocks them in Brevo now instead of waiting.
  for (const row of result.accounts) {
    if (row.role === "admin" || !ObjectId.isValid(row.accountId)) continue;
    // Raw driver: no schema casting, so pass an ObjectId (idIn adds the string form).
    const id: any = new ObjectId(row.accountId);
    row.openWork = !!(await db.collection("campaigninvites").findOne(openWorkFilter(id) as any, { projection: { _id: 1 } }));
    row.openMoney = !!(await db.collection("campaigntransactions").findOne(openMoneyFilter(id) as any, { projection: { _id: 1 } }));
  }
  result.accounts.sort((a, b) => Number(b.openMoney || b.openWork) - Number(a.openMoney || a.openWork));
  return result;
}
