/**
 * Daily profile-traffic history (collection: profile_traffic_daily).
 *
 * One row per profile per India calendar day: { profileType, profileId, day,
 * impressions, clicks }. Written next to the existing running totals
 * (profile.profileTraffic), which are unchanged. "impression" = the profile
 * page loaded; "click" = the profile's card was clicked in Search/Welcome.
 *
 * Recording is best-effort: callers never let a failure here break the page or
 * the totals. No personal data is stored — only counts per day.
 */
export const PROFILE_TRAFFIC_DAILY_COLLECTION = "profile_traffic_daily";

export type TrafficProfileType = "Influencer" | "Brand" | "Photographer";
export type TrafficKind = "impression" | "click";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** India calendar day of `at`, as YYYY-MM-DD (India has no daylight saving). */
export function istDayKey(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The subset of a Mongo collection this module uses. */
export interface DailyTrafficCollection {
  updateOne(filter: any, update: any, options?: any): Promise<unknown>;
  createIndex(spec: any, options?: any): Promise<unknown>;
  aggregate(pipeline: any[]): { toArray(): Promise<any[]> };
}

let indexEnsured = false;

/** A profile id as a string: accepts a string or an ObjectId; anything else is "". */
function idString(profileId: unknown): string {
  if (typeof profileId === "string") return profileId;
  const withHex = profileId as { toHexString?: () => string } | null;
  return typeof withHex?.toHexString === "function"
    ? withHex.toHexString()
    : "";
}

export async function recordDailyProfileTraffic(
  collection: DailyTrafficCollection,
  profileType: TrafficProfileType,
  profileId: unknown,
  kind: TrafficKind,
  now: Date = new Date(),
): Promise<void> {
  const id = idString(profileId);
  if (!id) return;
  if (!indexEnsured) {
    indexEnsured = true;
    await collection
      .createIndex(
        { profileType: 1, profileId: 1, day: 1 },
        { unique: true, name: "profile_day_unique" },
      )
      .catch(() => {
        indexEnsured = false; // retry on the next write
      });
  }
  await collection.updateOne(
    { profileType, profileId: id, day: istDayKey(now) },
    {
      $inc: { [kind === "impression" ? "impressions" : "clicks"]: 1 },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

/** Impressions and clicks over the last `days` India calendar days, today included. */
export async function profileTrafficForLastDays(
  collection: DailyTrafficCollection,
  profileType: TrafficProfileType,
  profileId: unknown,
  days: number,
  now: Date = new Date(),
): Promise<{ impressions: number; clicks: number }> {
  const id = idString(profileId);
  if (!id || days <= 0) return { impressions: 0, clicks: 0 };
  const firstDay = istDayKey(new Date(now.getTime() - (days - 1) * DAY_MS));
  const [row] = await collection
    .aggregate([
      { $match: { profileType, profileId: id, day: { $gte: firstDay } } },
      {
        $group: {
          _id: null,
          impressions: { $sum: "$impressions" },
          clicks: { $sum: "$clicks" },
        },
      },
    ])
    .toArray();
  return {
    impressions: Number(row?.impressions || 0),
    clicks: Number(row?.clicks || 0),
  };
}

/** Test hook: forget that the index was ensured. */
export function __resetProfileTrafficIndexFlag(): void {
  indexEnsured = false;
}
