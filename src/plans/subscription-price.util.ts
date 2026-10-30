/**
 * The one place a Premium subscription price is computed (₹, whole rupees).
 * Both checkout paths — manual UPI (POST /payment) and Razorpay
 * (POST /monetization/subscriptions/order) — charge exactly this; the amount
 * the browser shows is only checked against it, never trusted.
 *
 * Same rule the premium-upgrade page shows: the plan's duration offer
 * (discountMonthly / discountQuarterly / discountYearly, %) applies until the
 * admin's "Offer Ends At" date is over (plan-offer.util.ts). A coupon is only
 * accepted when no offer discount is running — it never replaces or stacks on one.
 */
import { withEndedOffersRemoved } from "./plan-offer.util";

export type BillingCycle = "monthly" | "quarterly" | "yearly";

/** Coupon code → % off. Mirrors the codes the premium-upgrade page accepts. */
export const SUBSCRIPTION_COUPONS: Record<string, number> = {
  TRENDSTARZ10: 10,
  TRENDSTARZ20: 20,
};

const OFFER_KEY: Record<BillingCycle, string> = {
  monthly: "discountMonthly",
  quarterly: "discountQuarterly",
  yearly: "discountYearly",
};

export function billingCycleFor(premiumDuration: string): BillingCycle {
  return premiumDuration === "1y"
    ? "yearly"
    : premiumDuration === "3m"
      ? "quarterly"
      : "monthly";
}

export interface SubscriptionPrice {
  baseRupees: number;
  discountRupees: number;
  finalRupees: number;
  discountPercent: number;
  discountSource: "none" | "plan_offer" | "coupon";
  couponCode: string | null;
}

export function computeSubscriptionPrice(
  plan: any,
  billingCycle: BillingCycle,
  couponCode?: string | null,
  now: Date = new Date(),
): SubscriptionPrice {
  plan = withEndedOffersRemoved(plan, now);
  const baseRupees = Number(plan?.price?.[billingCycle] ?? 0);
  const code = String(couponCode || "")
    .trim()
    .toUpperCase();
  const couponPercent = code ? SUBSCRIPTION_COUPONS[code] : undefined;
  if (code && couponPercent === undefined) {
    throw new Error("Invalid or expired coupon code.");
  }
  const offer = (Array.isArray(plan?.offers) ? plan.offers : []).find(
    (o: any) => o?.key === OFFER_KEY[billingCycle],
  );
  const offerPercent = Number(offer?.value) > 0 ? Number(offer.value) : 0;
  if (couponPercent !== undefined && offerPercent > 0) {
    throw new Error("Coupons can't be used while an offer is running.");
  }

  const discountPercent = couponPercent ?? offerPercent;
  const discountRupees = Math.round(baseRupees * (discountPercent / 100));
  return {
    baseRupees,
    discountRupees,
    finalRupees: Math.max(0, baseRupees - discountRupees),
    discountPercent,
    discountSource:
      couponPercent !== undefined
        ? "coupon"
        : offerPercent > 0
          ? "plan_offer"
          : "none",
    couponCode: couponPercent !== undefined ? code : null,
  };
}

/**
 * The browser sends the total it displayed. If it differs from the server's
 * price (stale page, edited request), refuse rather than charge an amount
 * the user didn't see.
 */
export function assertDisplayedPriceMatches(
  displayed: unknown,
  price: SubscriptionPrice,
): void {
  if (typeof displayed !== "number") return;
  if (Math.round(displayed) !== price.finalRupees) {
    throw new Error(
      `The price has changed to ₹${price.finalRupees}. Please reload the page and try again.`,
    );
  }
}
