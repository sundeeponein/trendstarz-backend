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

  it("accepts a coupon when no offer discount is running", () => {
    const p = computeSubscriptionPrice(plan, "monthly", " trendstarz20 ");
    expect(p.discountPercent).toBe(20);
    expect(p.finalRupees).toBe(499 - Math.round(499 * 0.2));
    expect(p.couponCode).toBe("TRENDSTARZ20");
  });

  it("refuses a coupon while an offer discount is running", () => {
    expect(() =>
      computeSubscriptionPrice(plan, "quarterly", "TRENDSTARZ20"),
    ).toThrow(/offer is running/);
  });

  describe("offer end date (Admin → Plans → Offer Ends At)", () => {
    // Saved from a date input: midnight UTC of 10 Nov = 05:30 IST on 10 Nov.
    const diwali = {
      price: { monthly: 399, quarterly: 1079, yearly: 3789 },
      offers: [
        { key: "discountYearly", value: 75 },
        { key: "discountMonthly", value: 25 },
      ],
      founderOfferEndsAt: new Date("2026-11-10T00:00:00.000Z"),
    };

    it("keeps the offer price through the whole end day in India", () => {
      const lastMinute = new Date("2026-11-10T18:29:00.000Z"); // 23:59 IST
      expect(
        computeSubscriptionPrice(diwali, "yearly", null, lastMinute).finalRupees,
      ).toBe(947);
    });

    it("charges the standard price once the end day is over", () => {
      const nextDay = new Date("2026-11-10T18:30:00.000Z"); // 00:00 IST 11 Nov
      const p = computeSubscriptionPrice(diwali, "yearly", null, nextDay);
      expect(p.finalRupees).toBe(3789);
      expect(p.discountSource).toBe("none");
      expect(computeSubscriptionPrice(diwali, "monthly", null, nextDay).finalRupees).toBe(399);
    });

    it("accepts coupons again after the offer ends", () => {
      const nextDay = new Date("2026-11-11T06:00:00.000Z");
      const p = computeSubscriptionPrice(diwali, "yearly", "TRENDSTARZ10", nextDay);
      expect(p.finalRupees).toBe(3789 - Math.round(3789 * 0.1));
    });

    it("never expires when no end date is set", () => {
      const p = computeSubscriptionPrice(
        { ...diwali, founderOfferEndsAt: null },
        "yearly",
        null,
        new Date("2030-01-01T00:00:00.000Z"),
      );
      expect(p.finalRupees).toBe(947);
    });
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
