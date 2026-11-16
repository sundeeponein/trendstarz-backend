import { lowestRate, rankShortlist } from "./shortlist-match";

describe("shortlist ranking (2026-11-16)", () => {
  const asOf = new Date("2026-11-16T00:00:00Z");
  const daysAgo = (n: number) => new Date(asOf.getTime() - n * 864e5);
  const creator = (id: string, over: any = {}) => ({
    _id: id,
    publicId: `INF${id}`,
    name: id,
    location: { state: "Telangana", district: "Hyderabad" },
    influencerCategory: "Food",
    lastLoginAt: daysAgo(3),
    socialMedia: [{ socialAccountId: `sa-${id}`, platform: "Instagram", handle: id, tier: "Micro", contentTypes: [{ name: "Reel", price: 800, enabled: true }] }],
    ...over,
  });
  const request = { city: "Warangal", category: "Fashion", budget: "under_5k" };

  it("orders by main niche, same city, activity, verified tier, budget, then id", () => {
    const rows = rankShortlist(
      request,
      [
        creator("a"), // other main niche, other city
        creator("b", { influencerCategory: "Fashion", lastLoginAt: daysAgo(200) }),
        creator("c", { influencerCategory: "Fashion", location: { state: "Telangana", district: "Warangal" }, lastLoginAt: daysAgo(200) }),
        creator("d", { influencerCategory: "Fashion" }),
        creator("e", { influencerCategory: "Fashion", socialMedia: [{ socialAccountId: "sa-e", platform: "Instagram", handle: "e", contentTypes: [{ name: "Reel", price: 5000 }] }] }),
        creator("f", { influencerCategory: "Fashion" }),
      ],
      new Map([["f", new Set(["sa-f"])]]),
      asOf,
    );
    expect(rows.map((r) => r.id)).toEqual(["c", "f", "d", "e", "b", "a"]);
    expect(rows[0].reasons).toContain("Based in Warangal");
    expect(rows[1].verified).toBe(true);
    expect(rows.find((r) => r.id === "e")!.fitsBudget).toBe(false);
  });

  it("prefers a Reel/Shorts price and skips switched-off or empty rates", () => {
    expect(
      lowestRate([{ contentTypes: [{ name: "Story", price: 100 }, { name: "Reel", price: 900 }, { name: "Shorts", price: 0 }, { name: "Reel 2", price: 300, enabled: false }] }]),
    ).toEqual({ name: "Reel", price: 900 });
    expect(lowestRate([{ contentTypes: [{ name: "Story", price: 100 }] }])).toEqual({ name: "Story", price: 100 });
    expect(lowestRate([])).toBeNull();
  });
});
