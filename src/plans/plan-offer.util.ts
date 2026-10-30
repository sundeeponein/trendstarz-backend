/**
 * When a plan's running offer is over (pure).
 *
 * Admin → Plans → "Offer Ends At" (founderOfferEndsAt) is a calendar date. It is
 * stored as midnight UTC of that date (05:30 IST), but the offer runs to the END
 * of that day in India time — same rule as campaign end dates. After it, the
 * duration discounts (discountMonthly/Quarterly/Yearly) and bonus months stop and
 * checkout charges the standard price. No date set = the offer never expires.
 */

import { endOfIstDay } from "../campaigns/campaign-deadlines.util";

/** Offer keys that belong to the running offer and stop at its end date. */
const ENDING_OFFER_KEY = /^(discount|bonusMonths|founderBonusMonths)/;

/** 23:59:59.999 IST on the admin's "Offer Ends At" date, or null when none is set. */
export function planOfferEndsAt(plan: any): Date | null {
  const raw = plan?.founderOfferEndsAt;
  if (raw === null || raw === undefined || raw === "") return null;
  const at = new Date(raw);
  return Number.isFinite(at.getTime()) ? endOfIstDay(at) : null;
}

export function isPlanOfferOver(plan: any, now: Date = new Date()): boolean {
  const endsAt = planOfferEndsAt(plan);
  return !!endsAt && endsAt.getTime() < now.getTime();
}

/**
 * The plan as buyers should see it now: once the offer is over its discount and
 * bonus offers read as 0. The stored plan is untouched (the admin keeps the
 * values for the next offer).
 */
export function withEndedOffersRemoved(plan: any, now: Date = new Date()): any {
  if (!plan || !isPlanOfferOver(plan, now)) return plan;
  const offers = Array.isArray(plan.offers) ? plan.offers : [];
  return {
    ...plan,
    offers: offers.map((o: any) =>
      ENDING_OFFER_KEY.test(String(o?.key || "")) ? { ...o, value: 0 } : o,
    ),
    discountLabel: "",
  };
}
