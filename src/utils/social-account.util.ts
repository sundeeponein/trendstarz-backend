import { Types } from "mongoose";

/**
 * Stage 3A-0 — stable identity + server-side merge for socialMedia[] entries.
 *
 * Profile saves send the whole socialMedia array from the browser. Before this,
 * the server replaced the stored array with it wholesale, so any field the
 * browser didn't echo back was lost and any field it did send was trusted. Now
 * the browser only ever supplies CREATOR_EDITABLE_SOCIAL_FIELDS; everything else
 * on an entry (identity, and the verification / observed-follower data that
 * Stage 3A-1+ adds) is server-owned and carried over from the stored entry.
 *
 * Keep derivePlatformKey in sync with cron/lib/socialAccountIdentity.js (a spec
 * checks the two agree).
 */

/** The only socialMedia fields a creator's browser may set. */
export const CREATOR_EDITABLE_SOCIAL_FIELDS = [
  "platform",
  "handle",
  "tier",
  "contentTypes",
  "selfReportedStats",
] as const;

/**
 * Canonical platform keys, derived from the `socialmedias` master-data names
 * actually in use (YouTube, Instagram, Facebook, TikTok, "X / Twitter", LinkedIn).
 * The stored display name (`platform`) is never rewritten; the key sits beside it.
 */
const PLATFORM_KEY_ALIASES: Record<string, string> = {
  instagram: "instagram",
  youtube: "youtube",
  facebook: "facebook",
  linkedin: "linkedin",
  tiktok: "tiktok",
  x: "x",
  twitter: "x",
  "x / twitter": "x",
  "x/twitter": "x",
  "twitter / x": "x",
};

export const KNOWN_PLATFORM_KEYS = [
  "instagram",
  "youtube",
  "facebook",
  "linkedin",
  "tiktok",
  "x",
] as const;

/** Stable internal key for a platform display name. Unknown names get a slug (and are reported by the backfill). */
function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function derivePlatformKey(platform: unknown): string {
  const name = scalarText(platform).trim().toLowerCase().replace(/\s+/g, " ");
  if (!name) return "";
  if (PLATFORM_KEY_ALIASES[name]) return PLATFORM_KEY_ALIASES[name];
  return name.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function isKnownPlatformKey(key: string): boolean {
  return (KNOWN_PLATFORM_KEYS as readonly string[]).includes(key);
}

/**
 * Server-generated account id: a 24-hex ObjectId string — the id convention
 * used throughout this codebase. Random + time-based, never derived from array
 * position, tier or handle, so it survives reorders and edits.
 */
export function newSocialAccountId(): string {
  return new Types.ObjectId().toHexString();
}

export function isSocialAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
}

function toPlain(entry: any): Record<string, any> {
  if (!entry || typeof entry !== "object") return {};
  if (typeof entry.toObject === "function") return entry.toObject();
  return { ...entry };
}

function sanitizeSelfReportedStats(
  value: any,
): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const num = (v: any) =>
    v === null || v === undefined || v === ""
      ? null
      : Number.isFinite(Number(v))
        ? Number(v)
        : null;
  return {
    avgLikes: num(value.avgLikes),
    avgComments: num(value.avgComments),
    postFrequencyPerWeek: num(value.postFrequencyPerWeek),
    lastUpdatedAt: new Date(),
  };
}

/**
 * Merges a browser-submitted socialMedia list (already validated/normalized by
 * normalizeSocialMediaList) into the stored one.
 *
 * - Identity: incoming entries are matched to stored ones by platformKey (the UI
 *   allows one account per platform; if a profile ever has two for the same
 *   platform they pair up in order). Browser-sent ids are ignored entirely.
 * - A matched entry keeps its socialAccountId (and Mongo _id) and every
 *   server-owned field; only CREATOR_EDITABLE_SOCIAL_FIELDS come from the browser.
 * - followersCount is server-owned: kept from the stored entry, 0 for new ones.
 * - selfReportedStats is kept from the stored entry unless the browser sends it
 *   (profile edit doesn't, and used to silently wipe it).
 * - An unmatched incoming entry is a new account and gets a new id; a stored
 *   entry with no incoming match was removed by the creator (as before).
 */
export function mergeSocialMediaEntries(
  existing: any[] | null | undefined,
  incoming: any[] | null | undefined,
  idFactory: () => string = newSocialAccountId,
): any[] {
  const queues = new Map<string, Record<string, any>[]>();
  for (const raw of Array.isArray(existing) ? existing : []) {
    const entry = toPlain(raw);
    const key = derivePlatformKey(entry.platformKey || entry.platform);
    const queue = queues.get(key) || [];
    queue.push(entry);
    queues.set(key, queue);
  }

  return (Array.isArray(incoming) ? incoming : []).map((item: any) => {
    const platformKey = derivePlatformKey(item?.platform);
    const stored = queues.get(platformKey)?.shift();

    // Start from the stored entry (all server-owned fields preserved), then
    // overwrite only what the creator may edit.
    const merged: Record<string, any> = stored ? { ...stored } : {};
    merged.platform = item?.platform ?? stored?.platform ?? "";
    merged.handle = item?.handle ?? stored?.handle ?? "";
    merged.tier = item?.tier !== undefined ? item.tier : (stored?.tier ?? "");
    merged.contentTypes = Array.isArray(item?.contentTypes)
      ? item.contentTypes
      : (stored?.contentTypes ?? []);
    const stats =
      item && Object.prototype.hasOwnProperty.call(item, "selfReportedStats")
        ? sanitizeSelfReportedStats(item.selfReportedStats)
        : undefined;
    if (stats) merged.selfReportedStats = stats;

    merged.platformKey = platformKey;
    const storedId: unknown = stored?.socialAccountId;
    merged.socialAccountId = isSocialAccountId(storedId)
      ? storedId
      : idFactory();
    merged.followersCount = stored ? (stored.followersCount ?? 0) : 0;
    return merged;
  });
}

/**
 * Accounts whose handle or tier differs between the stored array and a merged
 * one — paired the same way the merge pairs them (by platformKey, in order), so
 * it also works for pre-backfill entries that have no socialAccountId yet.
 */
export function socialIdentityChanges(
  before: any[] | null | undefined,
  after: any[] | null | undefined,
) {
  const queues = new Map<string, Record<string, any>[]>();
  for (const raw of Array.isArray(before) ? before : []) {
    const e = toPlain(raw);
    const key = derivePlatformKey(e.platformKey || e.platform);
    const queue = queues.get(key) || [];
    queue.push(e);
    queues.set(key, queue);
  }
  const changes: Array<{
    socialAccountId: string;
    platform: string;
    handleChanged: boolean;
    tierChanged: boolean;
    isNew: boolean;
  }> = [];
  for (const raw of Array.isArray(after) ? after : []) {
    const e = toPlain(raw);
    const old = queues
      .get(derivePlatformKey(e.platformKey || e.platform))
      ?.shift();
    const handleChanged = String(old?.handle ?? "") !== String(e.handle ?? "");
    const tierChanged = String(old?.tier ?? "") !== String(e.tier ?? "");
    if (!old || handleChanged || tierChanged) {
      changes.push({
        socialAccountId: String(e.socialAccountId || ""),
        platform: String(e.platform || ""),
        handleChanged,
        tierChanged,
        isNew: !old,
      });
    }
  }
  return changes;
}
