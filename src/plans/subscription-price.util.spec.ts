import {
  assertDisplayedPriceMatches,
  billingCycleFor,
  computeSubscriptionPrice,
} from "./subscription-price.util";

const plan = {
  price: { monthly: 499, quarterly: 1299, yearly: 4999 },
  offers: [
    { key: "discountQuarterly", value: 15 },
    { key: "discountYearly", value: 0 },
  ],
};

describe("computeSubscriptionPrice", () => {
  it("charges the base price when no offer or coupon applies", () => {
    const p = computeSubscriptionPrice(plan, "monthly");
    expect(p.finalRupees).toBe(499);
    expect(p.discountSource).toBe("none");
  });

  it("applies the duration offer, rounded like the checkout page", () => {
    const p = computeSubscriptionPrice(plan, "quarterly");
    expect(p.discountRupees).toBe(Math.round(1299 * 0.15));
    expect(p.finalRupees).toBe(1299 - Math.round(1299 * 0.15));
    expect(p.discountSource).toBe("plan_offer");
  });

  it("lets a coupon replace the plan offer (not stack)", () => {
    const p = computeSubscriptionPrice(plan, "quarterly", " trendstarz20 ");
    expect(p.discountPercent).toBe(20);
    expect(p.finalRupees).toBe(1299 - Math.round(1299 * 0.2));
    expect(p.couponCode).toBe("TRENDSTARZ20");
  });

  it("rejects an unknown coupon", () => {
    expect(() => computeSubscriptionPrice(plan, "monthly", "FREE100")).toThrow(
      /coupon/i,
    );
  });

  it("maps premium durations to billing cycles", () => {
    expect(billingCycleFor("1m")).toBe("monthly");
    expect(billingCycleFor("3m")).toBe("quarterly");
    expect(billingCycleFor("1y")).toBe("yearly");
  });
});

describe("assertDisplayedPriceMatches", () => {
  const price = computeSubscriptionPrice(plan, "monthly");

  it("accepts the matching total or no total", () => {
    expect(() => assertDisplayedPriceMatches(499, price)).not.toThrow();
    expect(() => assertDisplayedPriceMatches(undefined, price)).not.toThrow();
  });

  it("refuses a total the server would not charge (e.g. an edited ₹1 request)", () => {
    expect(() => assertDisplayedPriceMatches(1, price)).toThrow(/₹499/);
  });
});
