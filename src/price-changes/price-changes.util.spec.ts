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
});
