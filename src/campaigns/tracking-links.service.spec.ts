import { TrackingLinksService } from "./tracking-links.service";

describe("TrackingLinksService.getAdminAnalytics — list sizes", () => {
  const chain = (rows: any[]) => ({
    sort: () => chain(rows),
    select: () => chain(rows),
    lean: () => Promise.resolve(rows),
  });
  const links = Array.from({ length: 40 }, (_, i) => ({
    _id: `l${i}`,
    code: `C${i}`,
    moduleType: "campaign",
    campaignId: "camp1",
    hostId: "brand1",
    hostType: "brand",
    recipientId: `r${i}`,
    // 30 with clicks, 10 without.
    clickCount: i < 30 ? 100 - i : 0,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  }));
  const make = () =>
    new TrackingLinksService(
      { find: () => chain(links) } as any,
      { aggregate: () => Promise.resolve([]) } as any,
      {} as any,
      {
        find: () => chain([{ _id: "camp1", campaignNumber: 7, title: "C" }]),
      } as any,
      { find: () => chain([{ _id: "brand1", brandName: "B" }]) } as any,
      { find: () => chain([]) } as any,
      { find: () => chain([]) } as any,
      { aggregate: () => Promise.resolve([]) } as any,
    );

  it("returns up to `limit` rows per list, with the exact totals", async () => {
    const res: any = await make().getAdminAnalytics({ limit: 25 });
    expect(res.topPerformers).toHaveLength(25);
    expect(res.topPerformersTotal).toBe(40);
    expect(res.topPerformers[0].clickCount).toBe(100); // most clicks first
    expect(res.zeroActivity).toHaveLength(10);
    expect(res.zeroActivityTotal).toBe(10);
  });

  it("allows up to 1000 rows so the admin page can page through them", async () => {
    const res: any = await make().getAdminAnalytics({ limit: 1000 });
    expect(res.topPerformers).toHaveLength(40);
    const capped: any = await make().getAdminAnalytics({ limit: 5000 });
    expect(capped.topPerformers).toHaveLength(40); // capped at 1000, here all 40
  });
});
