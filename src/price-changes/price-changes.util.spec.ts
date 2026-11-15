import { holdRateRows, holdSocialRates, isBigJump } from "./price-changes.util";

describe("price changes", () => {
  it("a big jump is at least double the current price", () => {
    expect(isBigJump(500, 999)).toBe(false);
    expect(isBigJump(500, 1000)).toBe(true);
    expect(isBigJump(500, 2000)).toBe(true);
    expect(isBigJump(null, 5000)).toBe(false); // new rate
    expect(isBigJump(0, 5000)).toBe(false);
    expect(isBigJump(800, 400)).toBe(false); // a cut
  });

  it("ordinary changes apply and are recorded; turning on/off alone is not", () => {
    const before = [
      { name: "Reel", price: 1000, enabled: true },
      { name: "Story", price: 500, enabled: true },
    ];
    const next = [
      { name: "Reel", price: 1500, enabled: true },
      { name: "Story", price: 500, enabled: false },
      { name: "Post", price: 700, enabled: true },
    ];
    const r = holdRateRows(before, next, { source: "pricing" });
    expect(r.rows.map((x) => x.price)).toEqual([1500, 500, 700]);
    expect(r.held).toEqual([]);
    expect(r.applied.map((c) => [c.rateName, c.oldPrice, c.newPrice])).toEqual([
      ["Reel", 1000, 1500],
      ["Post", null, 700],
    ]);
  });

  it("a doubled price is held at the current price and its confirmed date", () => {
    const confirmed = new Date("2026-10-01");
    const before = [{ name: "Reel", price: 500, priceConfirmedAt: confirmed }];
    const next = [{ name: "reel", price: 2000, priceConfirmedAt: new Date() }];
    const r = holdRateRows(before, next, { source: "social", socialAccountId: "sa1", platform: "Instagram" });
    expect(r.rows[0].price).toBe(500);
    expect(r.rows[0].priceConfirmedAt).toBe(confirmed);
    expect(r.applied).toEqual([]);
    expect(r.held).toEqual([
      { source: "social", socialAccountId: "sa1", platform: "Instagram", rateName: "reel", oldPrice: 500, newPrice: 2000 },
    ]);
  });

  it("social rates are compared per account; a new account's rates are new", () => {
    const before = [{ socialAccountId: "a", platform: "Instagram", contentTypes: [{ name: "Reel", price: 500 }] }];
    const merged = [
      { socialAccountId: "a", platform: "Instagram", contentTypes: [{ name: "Reel", price: 1200 }] },
      { socialAccountId: "b", platform: "YouTube", contentTypes: [{ name: "Short", price: 9000 }] },
    ];
    const r = holdSocialRates(before, merged);
    expect(r.socialMedia[0].contentTypes[0].price).toBe(500);
    expect(r.socialMedia[1].contentTypes[0].price).toBe(9000);
    expect(r.held.map((c) => c.socialAccountId)).toEqual(["a"]);
    expect(r.applied.map((c) => [c.socialAccountId, c.oldPrice])).toEqual([["b", null]]);
  });

  describe("usual-range rule (2026-11-15)", () => {
    const before = [
      {
        socialAccountId: "a",
        platform: "Instagram",
        tier: "Macro",
        contentTypes: [
          { name: "Reel", price: 50, enabled: true },
          { name: "Story (24h)", price: 500, enabled: true }, // already above Starter's ₹50–60
          { name: "Photo post", price: 50, enabled: true }, // no range: doubling rule
        ],
      },
    ];
    const save = (rows: Array<{ name: string; price: number; enabled?: boolean }>, tier = "Starter") =>
      holdSocialRates(before, [{ ...before[0], contentTypes: rows }], new Map([["a", tier]]));
    const others = before[0].contentTypes.slice(1);

    it("within the range applies even when it doubles (Starter Reel ₹50 → ₹100 / ₹150)", () => {
      expect(save([{ name: "Reel", price: 100 }, ...others]).held).toEqual([]);
      expect(save([{ name: "Reel", price: 150 }, ...others]).held).toEqual([]);
    });

    it("above the range waits, even when it doesn't double; brands keep the old price", () => {
      const r = save([{ name: "Reel", price: 160 }, ...others]);
      expect(r.held.map((c) => c.newPrice)).toEqual([160]);
      expect(r.socialMedia[0].contentTypes[0].price).toBe(50);
    });

    it("the tier passed in decides — a Macro tier picked in the same save doesn't count", () => {
      // Caller passes the approval tier (verified/checked/Starter), not the new dropdown value.
      expect(save([{ name: "Reel", price: 10000 }, ...others], "Starter").held.map((c) => c.newPrice)).toEqual([10000]);
      expect(save([{ name: "Reel", price: 10000 }, ...others], "Macro").held).toEqual([]);
    });

    it("prices already above the range stay live; cuts always apply", () => {
      expect(save([{ name: "Reel", price: 50 }, ...others]).held).toEqual([]); // untouched Story ₹500
      const cut = save([{ name: "Reel", price: 50 }, { name: "Story (24h)", price: 400 }, others[1]]);
      expect(cut.held).toEqual([]);
      expect(cut.applied.map((c) => c.newPrice)).toEqual([400]);
    });

    it("a NEW rate above the range is held and stays off until approved", () => {
      const r = save([...before[0].contentTypes, { name: "YouTube Video", price: 900, enabled: true }]);
      expect(r.held.map((c) => [c.rateName, c.oldPrice, c.newPrice])).toEqual([["YouTube Video", null, 900]]);
      const row = r.socialMedia[0].contentTypes[3];
      expect([row.price, row.enabled]).toEqual([0, false]);
    });

    it("rates without a range keep the doubling rule", () => {
      expect(save([before[0].contentTypes[0], before[0].contentTypes[1], { name: "Photo post", price: 99 }]).held).toEqual([]);
      expect(save([before[0].contentTypes[0], before[0].contentTypes[1], { name: "Photo post", price: 100 }]).held.length).toBe(1);
    });

    it("no approval tiers given (photographers): doubling rule everywhere", () => {
      const r = holdSocialRates(before, [{ ...before[0], contentTypes: [{ name: "Reel", price: 99 }, ...others] }]);
      expect(r.held).toEqual([]);
    });
  });
});
