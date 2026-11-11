/**
 * Product campaigns that ship (2026-11-11). One place for the timeline so the
 * campaign form, the accept check, the delivery rules, the jobs and every screen
 * agree. Example (defaults), campaign start 11 Nov:
 *
 *   accept by   13 Nov 23:59 IST   start + acceptDays (2)
 *   ship by     15 Nov 23:59 IST   accept-by + shipByDays (2)
 *   post from   18 Nov             accept-by + shippingDays (5) — the date picker's minimum
 *   leave free  18 Nov 00:00 IST   ship-by + releaseAfterShipByDays (3), nothing shipped
 *   cap         start + capDays (15) — no deadline goes past it
 *
 * Only campaigns stamped productTimeline:true use these rules; campaigns created
 * before keep their own dates (acceptance = the day before start).
 */
import { endOfIstDay, postDateAfterDelivery } from "./campaign-deadlines.util";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export const PRODUCT_TIMELINE_DEFAULTS = {
  acceptDays: 2,
  shipByDays: 2,
  shippingDays: 5,
  postAfterDays: 7,
  releaseAfterShipByDays: 3,
  capDays: 15,
  /** A late-delivery window shorter than this is never held against the creator. */
  minFairPostingDays: 2,
};

export type ProductTimelineSettings = typeof PRODUCT_TIMELINE_DEFAULTS;

function positive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** Admin settings → the numbers the timeline uses (defaults when unset). */
export function productTimelineSettings(settings: any): ProductTimelineSettings {
  const d = PRODUCT_TIMELINE_DEFAULTS;
  return {
    ...d,
    acceptDays: positive(settings?.productAcceptanceDays, d.acceptDays),
    shipByDays: positive(settings?.productShipByDays, d.shipByDays),
    shippingDays: positive(settings?.productShippingDays, d.shippingDays),
    postAfterDays: positive(settings?.postAfterDeliveryDays, d.postAfterDays),
    capDays: positive(settings?.maxCampaignDurationDays, d.capDays),
  };
}

export function isShippedProductCampaign(campaign: any): boolean {
  return String(campaign?.campaignType || "") === "product" && campaign?.productShippingRequired === true;
}

/** India calendar day of `t` as midnight UTC of that date (how start/end/post dates are stored). */
export function istDay(t: Date | string | number): number {
  const shifted = new Date(new Date(t).getTime() + IST_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

/** The timeline's dates for a campaign starting on `start`. */
export function computeProductTimeline(start: Date | string, s: ProductTimelineSettings) {
  const startDay = istDay(start);
  const acceptByDay = startDay + s.acceptDays * DAY_MS;
  return {
    // Same instant form as the old rule (endOfIstDay), just a different day.
    acceptanceDeadline: endOfIstDay(new Date(acceptByDay + 12 * 60 * 60 * 1000)),
    shipByDate: endOfIstDay(new Date(acceptByDay + s.shipByDays * DAY_MS + 12 * 60 * 60 * 1000)),
    earliestPostDate: new Date(acceptByDay + s.shippingDays * DAY_MS),
  };
}

/** When a creator may leave without penalty if nothing was shipped: start of (ship-by day + N) in India. */
export function releaseAvailableAt(shipByDate: Date | string, releaseAfterShipByDays: number): Date {
  return new Date(istDay(shipByDate) + releaseAfterShipByDays * DAY_MS - IST_OFFSET_MS);
}

/**
 * The creator's post date once the product arrives. Their chosen date stays when
 * the product arrives before it; otherwise up to `postAfterDays` from delivery
 * (never past the cap, never earlier than their own date).
 */
export function postDateOnDelivery(
  deliveredAt: Date,
  chosenPostDate: unknown,
  campaignStart: unknown,
  s: Pick<ProductTimelineSettings, "postAfterDays" | "capDays">,
): { postDate: Date; adjusted: boolean } {
  const chosen = chosenPostDate ? new Date(chosenPostDate as any) : null;
  if (chosen && Number.isFinite(chosen.getTime()) && istDay(chosen) > istDay(deliveredAt)) {
    return { postDate: chosen, adjusted: false };
  }
  const due = postDateAfterDelivery(deliveredAt, campaignStart, s.postAfterDays, s.capDays);
  if (chosen && Number.isFinite(chosen.getTime()) && chosen.getTime() > due.getTime()) {
    return { postDate: chosen, adjusted: false };
  }
  return { postDate: due, adjusted: true };
}

/** Whole India days the creator had to post after the product arrived. */
export function postingDaysAfterDelivery(deliveredAt: Date | string, postDate: Date | string): number {
  return Math.round((istDay(postDate) - istDay(deliveredAt)) / DAY_MS);
}
