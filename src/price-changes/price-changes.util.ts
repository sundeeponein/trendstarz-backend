import { rangeFor } from "../collaboration-score/rate-suggestion.util";
/**
 * Creator price changes (2026-11-10).
 *
 * Every change to a creator's rate is recorded (old → new, when) so admins can
 * see it. Ordinary changes apply straight away: no re-verification, the profile
 * stays in search and invites.
 *
 * A BIG JUMP — the new price is at least BIG_JUMP_FACTOR × the current one —
 * is held: the profile keeps the current price (what brands see) and the new
 * one waits in price_changes as "pending" until an admin approves it.
 *
 * USUAL-RANGE RULE (2026-11-15, influencer social rates): for a rate that has a
 * usual range (Reel/Shorts, Video, Story), the range decides instead:
 *  - a raise or a NEW rate ABOVE the top of the range waits for approval
 *    (a held new rate stays off — brands don't see it until approved);
 *  - anything within the range applies straight away, even if it doubles;
 *  - cuts always apply; untouched rates (even above the range) stay live.
 * The range comes from the "approval tier" the caller passes: the admin-
 * verified tier, else TrendStarZ's checked YouTube tier, else Starter.
 * Rates with no range (Photo post…) and photographer pricing keep the
 * doubling rule.
 *
 * Two kinds of rate lists are covered:
 *  - "social":  socialMedia[].contentTypes[] (influencers and photographers)
 *  - "pricing": photographer pricing[] (Starting Price, Per Shoot, Hourly…)
 */

export const BIG_JUMP_FACTOR = 2;

export type PriceSource = "social" | "pricing";

export interface PriceChange {
  source: PriceSource;
  /** "" for photographer pricing rows. */
  socialAccountId: string;
  /** "" for photographer pricing rows. */
  platform: string;
  rateName: string;
  /** null = a new rate (nothing before). */
  oldPrice: number | null;
  newPrice: number;
}

export function isBigJump(oldPrice: number | null, newPrice: number): boolean {
  return (
    oldPrice !== null &&
    Number.isFinite(oldPrice) &&
    oldPrice > 0 &&
    Number.isFinite(newPrice) &&
    newPrice >= oldPrice * BIG_JUMP_FACTOR
  );
}

/** Lower-cased, trimmed rate name — rows are matched by it (as mergeRateRows does). */
export function rateKey(name: unknown): string {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

function plain(value: any): Record<string, any> {
  if (value && typeof value.toObject === "function") return value.toObject();
  return value && typeof value === "object" ? { ...value } : {};
}

/**
 * Compares one rate list before and after a save. Rows whose price moved are
 * returned as `applied`, except held ones (big jumps, or above the usual range
 * when `rangeTop` is given): those rows are put back to the stored price (and
 * its confirmed date) and returned as `held`. Turning a rate on/off without
 * changing its price is not a price change. A stored ₹0 counts as no price.
 */
export function holdRateRows(
  storedRows: unknown,
  nextRows: unknown,
  where: { source: PriceSource; socialAccountId?: string; platform?: string },
  /**
   * Usual range for a rate under the approval tier: { top } (null top = open-
   * ended), or null when the rate has no range — then the doubling rule applies.
   */
  rangeTop?: (rateName: string) => { top: number | null } | null,
): { rows: any[]; applied: PriceChange[]; held: PriceChange[] } {
  const byName = new Map<string, Record<string, any>>();
  for (const raw of Array.isArray(storedRows) ? storedRows : []) {
    const row = plain(raw);
    const key = rateKey(row?.name);
    if (key && !byName.has(key)) byName.set(key, row);
  }
  const applied: PriceChange[] = [];
  const held: PriceChange[] = [];
  const rows = (Array.isArray(nextRows) ? nextRows : []).map((raw: any) => {
    const row = plain(raw);
    const name = String(row?.name ?? "").trim();
    const newPrice = Number(row?.price);
    if (!name || !Number.isFinite(newPrice)) return row;
    const stored = byName.get(rateKey(name));
    const storedPrice = stored ? Number(stored.price) : NaN;
    const oldPrice = Number.isFinite(storedPrice) && storedPrice > 0 ? storedPrice : null;
    if (oldPrice === newPrice) return row;
    // A new rate at ₹0 (or a ₹0 rate staying ₹0) is not a price.
    if (oldPrice === null && newPrice <= 0) return row;
    const change: PriceChange = {
      source: where.source,
      socialAccountId: String(where.socialAccountId ?? ""),
      platform: String(where.platform ?? ""),
      rateName: name,
      oldPrice,
      newPrice,
    };
    const range = rangeTop ? rangeTop(name) : null;
    const raised = oldPrice === null || newPrice > oldPrice;
    const hold = range
      ? raised && range.top !== null && newPrice > range.top
      : isBigJump(oldPrice, newPrice);
    if (hold) {
      held.push(change);
      // A new rate has no price to keep showing: it stays off until approved.
      const keptRow: Record<string, any> =
        oldPrice === null
          ? { ...row, price: 0, enabled: false }
          : { ...row, price: oldPrice };
      if (Object.prototype.hasOwnProperty.call(row, "priceConfirmedAt")) {
        keptRow.priceConfirmedAt = stored?.priceConfirmedAt ?? null;
      }
      return keptRow;
    }
    applied.push(change);
    return row;
  });
  return { rows, applied, held };
}

/**
 * The same for a whole socialMedia list (already merged by
 * mergeSocialMediaEntries, so each entry keeps its stored socialAccountId).
 * New accounts have no stored rates: their rates are new, never big jumps.
 */
export function holdSocialRates(
  before: unknown,
  merged: unknown,
  /**
   * socialAccountId → the tier the usual range is taken from (verified, else
   * checked YouTube, else Starter — decided by the caller). Not given (e.g.
   * photographers): the doubling rule applies to every rate.
   */
  approvalTiers?: Map<string, string>,
): { socialMedia: any[]; applied: PriceChange[]; held: PriceChange[] } {
  const stored = new Map<string, Record<string, any>>();
  for (const raw of Array.isArray(before) ? before : []) {
    const e = plain(raw);
    const id = String(e?.socialAccountId || "");
    if (id && !stored.has(id)) stored.set(id, e);
  }
  const applied: PriceChange[] = [];
  const held: PriceChange[] = [];
  const socialMedia = (Array.isArray(merged) ? merged : []).map((raw: any) => {
    const entry = plain(raw);
    if (!Array.isArray(entry.contentTypes)) return entry;
    const socialAccountId = String(entry.socialAccountId || "");
    const result = holdRateRows(
      stored.get(socialAccountId)?.contentTypes,
      entry.contentTypes,
      { source: "social", socialAccountId, platform: String(entry.platform || "") },
      approvalTiers
        ? (rateName) => rangeFor(approvalTiers.get(socialAccountId) || "Starter", rateName)
        : undefined,
    );
    applied.push(...result.applied);
    held.push(...result.held);
    return { ...entry, contentTypes: result.rows };
  });
  return { socialMedia, applied, held };
}
