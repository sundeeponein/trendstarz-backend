import { AnalyticsEventsService } from "./analytics-events.service";

describe("AnalyticsEventsService ingest", () => {
  const model = () => {
    const inserted: any[] = [];
    return {
      inserted,
      insertMany: jest.fn(async (docs: any[]) => inserted.push(...docs)),
      find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
    };
  };

  it("files events under the signed-in sender, never the body's userId", async () => {
    const m = model();
    await new AnalyticsEventsService(m as any).ingestEvents(
      { events: [{ eventType: "campaign_invite_sent", userId: "victim", userRole: "admin", metadata: { campaignId: "c1" } }] },
      { userId: "me", role: "brand" },
    );
    expect(m.inserted[0]).toMatchObject({ userId: "me", userRole: "brand", metadata: { campaignId: "c1" } });
  });

  it("caps events per request and keeps metadata small and flat", async () => {
    const m = model();
    const events = Array.from({ length: 500 }, () => ({
      eventType: "campaign_invite_sent",
      metadata: { campaignId: "c", nested: { a: 1 }, $where: "x", long: "y".repeat(5000) },
    }));
    await new AnalyticsEventsService(m as any).ingestEvents({ events }, { userId: "me", role: "brand" });
    expect(m.inserted).toHaveLength(50);
    expect(m.inserted[0].metadata).toEqual({ campaignId: "c", long: "y".repeat(200) });
  });
});
