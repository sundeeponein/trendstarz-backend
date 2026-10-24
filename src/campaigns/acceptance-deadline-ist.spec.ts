import { CampaignsService } from "./campaigns.service";

describe("campaign acceptance deadline (India time)", () => {
  const normalize = (data: any) =>
    (CampaignsService.prototype as any).normalizeCampaignPayload.call(
      Object.create(CampaignsService.prototype),
      data,
    );

  it("closes at 23:59:59 IST on the day before the start date", () => {
    const n = normalize({ startDate: "2026-11-01" });
    expect(n.acceptanceDeadline.toISOString()).toBe("2026-10-31T18:29:59.999Z"); // 31 Oct 11:59:59 PM IST
  });

  it("ignores a deadline sent by the client", () => {
    expect(normalize({ acceptanceDeadline: "2030-01-01" }).acceptanceDeadline).toBeUndefined();
  });
});
