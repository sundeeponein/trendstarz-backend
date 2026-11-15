import { rangeTopFor } from "../collaboration-score/rate-suggestion.util";
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
 * Exception (2026-11-15): a raise up to the top of the usual range for the
 * account's ADMIN-VERIFIED tier applies straight away even when it doubles
 * (e.g. Starter Reel ₹50 → ₹100). Above that range the doubling rule applies.
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
 * returned as `applied`, except big jumps: those rows are put back to the stored
 * price (and its confirmed date) and returned as `held`. Turning a rate on/off
 * without changing its price is not a price change.
 */
export function holdRateRows(
  storedRows: unknown,
  nextRows: unknown,
  where: { source: PriceSource; socialAccountId?: string; platform?: string },
  /** Top of the usual range for a rate (verified tier only); raises up to it are never held. */
  rangeTop?: (rateName: string) => number | null,
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
    const oldPrice = Number.isFinite(storedPrice) ? storedPrice : null;
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
    const top = rangeTop ? rangeTop(name) : null;
    const withinUsualRange = top !== null && newPrice <= top;
    if (isBigJump(oldPrice, newPrice) && !withinUsualRange) {
      held.push(change);
      const keptRow: Record<string, any> = { ...row, price: oldPrice };
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
  /** socialAccountId → the tier an admin verified for that account (as stored before this save). */
  verifiedTiers?: Map<string, string>,
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
      verifiedTiers?.has(socialAccountId)
        ? (rateName) => rangeTopFor(verifiedTiers.get(socialAccountId), rateName)
        : undefined,
    );
    applied.push(...result.applied);
    held.push(...result.held);
    return { ...entry, contentTypes: result.rows };
  });
  return { socialMedia, applied, held };
}
