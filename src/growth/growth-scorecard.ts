import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

/**
 * Growth plan 2026-11-16 (move 5): the five numbers checked every Monday, plus
 * where signups came from. Read-only; shown on Admin → Growth and in the
 * Monday email. Our own accounts (admin tag "Founder-owned" or "Internal/Test")
 * are left out, so the numbers show outside demand only.
 */

export const HOUSE_TAGS = ["founder-owned", "internal/test", "internal test"];
const DAY = 24 * 60 * 60 * 1000;

export function isHouseAccount(doc: any): boolean {
  const tags: unknown[] = Array.isArray(doc?.adminTags) ? doc.adminTags : [];
  return tags.some((t) => HOUSE_TAGS.includes(String(t ?? "").trim().toLowerCase()));
}

export interface Scorecard {
  at: Date;
  /** Outside brands with at least one campaign that went live (ever), and how many went live for the first time in the last 7 days. */
  outsideBrands: { total: number; newThisWeek: number };
  invitesSent: { last7: number; previous7: number };
  /** Of invites sent 3–33 days ago (enough time to answer): share accepted. */
  acceptRate: { accepted: number; sent: number; percent: number | null };
  /** Creator work approved/completed in the last 30 days. */
  workFinished30d: number;
  /** Approved creators who opened the app in the last 30 days. */
  activeCreators30d: number;
  /** Pending invites on live campaigns with no answer for 24h+. */
  unansweredInvites: number;
  /** Shortlist requests not handled yet. */
  newShortlistRequests: number;
  signupsBySource: { days: number; rows: Array<{ source: string; creators: number; brands: number }> };
}

/** Signup source as stored, folded into one label ("ig" and "instagram" are the same). */
export function sourceLabel(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s === "unknown") return "unknown";
  if (s === "ig" || s.startsWith("instagram")) return "instagram";
  if (s === "wa" || s.startsWith("whatsapp")) return "whatsapp";
  if (s === "fb" || s.startsWith("facebook")) return "facebook";
  return s.slice(0, 40);
}

const asDate = (v: any) => (v ? new Date(v) : null);
const lastActive = (d: any) => {
  const t = [asDate(d?.lastLoginAt), asDate(d?.lastOpenedAt)].filter(Boolean).map((x) => x!.getTime());
  return t.length ? Math.max(...t) : 0;
};

export async function signupsBySource(db: Db, since: Date) {
  const rows = new Map<string, { source: string; creators: number; brands: number }>();
  const add = (source: string, key: "creators" | "brands") => {
    const row = rows.get(source) || { source, creators: 0, brands: 0 };
    row[key] += 1;
    rows.set(source, row);
  };
  for (const [col, key] of [
    ["influencers", "creators"],
    ["photographers", "creators"],
    ["brands", "brands"],
  ] as const) {
    const docs = await db
      .collection(col)
      .find(
        { isDeleted: { $ne: true }, $or: [{ firstRegisteredAt: { $gte: since } }, { firstRegisteredAt: null, createdAt: { $gte: since } }] },
        { projection: { "signupAttribution.source": 1, adminTags: 1 } },
      )
      .toArray();
    for (const d of docs) if (!isHouseAccount(d)) add(sourceLabel((d as any).signupAttribution?.source), key);
  }
  return [...rows.values()].sort((a, b) => b.creators + b.brands - (a.creators + a.brands));
}

export async function unansweredInviteIds(db: Db, now: Date): Promise<any[]> {
  const pending = await db
    .collection("campaigninvites")
    .find(
      { status: "pending", createdAt: { $lte: new Date(now.getTime() - DAY) } },
      { projection: { campaignId: 1, influencerId: 1, brandId: 1, recipientRole: 1, createdAt: 1, unansweredCreatorReminderAt: 1, unansweredHostNudgeAt: 1 } },
    )
    .toArray();
  if (!pending.length) return [];
  const ids = [...new Set(pending.map((p: any) => String(p.campaignId)))].filter((id) => ObjectId.isValid(id));
  const live = await db
    .collection("campaigns")
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, status: "active" }, { projection: { _id: 1 } })
    .toArray();
  const liveIds = new Set(live.map((c) => String(c._id)));
  return pending.filter((p: any) => liveIds.has(String(p.campaignId)));
}

export async function buildScorecard(db: Db, now = new Date()): Promise<Scorecard> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  // 1. Outside brands with a campaign that went live.
  const brands = await db.collection("brands").find({}, { projection: { adminTags: 1 } }).toArray();
  const house = new Set(brands.filter(isHouseAccount).map((b) => String(b._id)));
  const brandIds = new Set(brands.map((b) => String(b._id)));
  const firstLive = new Map<string, number>();
  const live = await db
    .collection("campaigns")
    .find({ slotUsedAt: { $ne: null } }, { projection: { brandId: 1, slotUsedAt: 1, ownerType: 1 } })
    .toArray();
  for (const c of live as any[]) {
    const id = String(c.brandId);
    const owner = String(c.ownerType || "brand").toLowerCase();
    if (owner !== "brand" || !brandIds.has(id) || house.has(id)) continue;
    const t = new Date(c.slotUsedAt).getTime();
    if (!firstLive.has(id) || t < firstLive.get(id)!) firstLive.set(id, t);
  }
  const weekAgo = ago(7).getTime();

  // 2–3. Invites.
  const invites = db.collection("campaigninvites");
  const last7 = await invites.countDocuments({ createdAt: { $gte: ago(7) } });
  const previous7 = await invites.countDocuments({ createdAt: { $gte: ago(14), $lt: ago(7) } });
  const window = { createdAt: { $gte: ago(33), $lt: ago(3) } };
  const sent = await invites.countDocuments(window);
  const accepted = await invites.countDocuments({ ...window, acceptedAt: { $ne: null } });

  // 4. Finished work.
  const workFinished30d = await invites.countDocuments({
    status: { $in: ["approved", "completed"] },
    completedAt: { $gte: ago(30) },
  });

  // 5. Active creators.
  let activeCreators30d = 0;
  for (const col of ["influencers", "photographers"]) {
    const docs = await db
      .collection(col)
      .find(
        { status: "accepted", isDeleted: { $ne: true } },
        { projection: { lastLoginAt: 1, lastOpenedAt: 1, adminTags: 1 } },
      )
      .toArray();
    activeCreators30d += docs.filter((d) => !isHouseAccount(d) && lastActive(d) >= ago(30).getTime()).length;
  }

  const unanswered = await unansweredInviteIds(db, now);
  const newShortlistRequests = await db.collection("shortlist_requests").countDocuments({ status: "new" });

  return {
    at: now,
    outsideBrands: {
      total: firstLive.size,
      newThisWeek: [...firstLive.values()].filter((t) => t >= weekAgo).length,
    },
    invitesSent: { last7, previous7 },
    acceptRate: { accepted, sent, percent: sent ? Math.round((accepted / sent) * 100) : null },
    workFinished30d,
    activeCreators30d,
    unansweredInvites: unanswered.length,
    newShortlistRequests,
    signupsBySource: { days: 30, rows: await signupsBySource(db, ago(30)) },
  };
}

/** Plain-text Monday email. */
export function scorecardEmailText(s: Scorecard, adminUrl: string): string {
  const pct = s.acceptRate.percent === null ? "no invites yet" : `${s.acceptRate.percent}% (${s.acceptRate.accepted} of ${s.acceptRate.sent})`;
  const sources = s.signupsBySource.rows.length
    ? s.signupsBySource.rows.map((r) => `  ${r.source}: ${r.creators} creator(s), ${r.brands} brand(s)`).join("\n")
    : "  none";
  return [
    "TrendStarZ — this week's numbers",
    "",
    `Outside brands with a live campaign: ${s.outsideBrands.total} (${s.outsideBrands.newThisWeek} new this week)`,
    `Invites sent, last 7 days: ${s.invitesSent.last7} (week before: ${s.invitesSent.previous7})`,
    `Invites accepted: ${pct}`,
    `Creator work finished, last 30 days: ${s.workFinished30d}`,
    `Creators active, last 30 days: ${s.activeCreators30d}`,
    "",
    `Waiting on you: ${s.newShortlistRequests} new shortlist request(s), ${s.unansweredInvites} invite(s) unanswered for 24h+`,
    "",
    "Signups in the last 30 days, by source:",
    sources,
    "",
    `Details: ${adminUrl}`,
  ].join("\n");
}
