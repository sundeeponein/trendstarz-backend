import { AnalyticsEventSchema, ANALYTICS_EVENT_RETENTION_DAYS } from "./analytics-event.schema";

describe("analytics events retention", () => {
  it("keeps events 45 days (TTL on receivedAt) and indexes the duplicate check", () => {
    expect(ANALYTICS_EVENT_RETENTION_DAYS).toBe(45);
    const indexes = AnalyticsEventSchema.indexes();
    expect(indexes).toContainEqual([{ receivedAt: 1 }, expect.objectContaining({ expireAfterSeconds: 45 * 86400 })]);
    expect(indexes.map(([keys]) => keys)).toContainEqual({ eventType: 1, "metadata.inviteId": 1, "metadata.completionStage": 1 });
  });
});
