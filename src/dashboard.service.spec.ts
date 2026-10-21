import { DashboardService } from "./dashboard.service";

describe("DashboardService — the creator's dashboard shares only what a creator may see", () => {
  it("loads each campaign with the creator field list, never the host's account, and no raw invites", async () => {
    const populate = jest.fn().mockReturnValue({
      lean: async () => [
        {
          _id: "inv1",
          status: "pending",
          brandId: "brand1",
          campaignId: { _id: "c1", title: "Diwali Reels" },
        },
        { _id: "inv2", status: "accepted", campaignId: { _id: "c2", title: "Food walk" } },
      ],
    });
    const service = new DashboardService(
      { find: jest.fn().mockReturnValue({ populate }) } as any,
      {} as any,
      {} as any,
      { findById: () => ({ lean: async () => ({ _id: "inf1", name: "Ravi" }) }) } as any,
      { find: () => ({ select: () => ({ lean: async () => [] }) }) } as any,
    );
    const res: any = await service.getInfluencerDashboard("inf1");
    expect(populate).toHaveBeenCalledTimes(1);
    const [path, fields] = populate.mock.calls[0];
    expect(path).toBe("campaignId");
    expect(fields).not.toMatch(/moderation|adminOverride|email|phone/);
    const json = JSON.stringify(res);
    expect(json).not.toContain("newInvites");
    expect(json).not.toContain("statusDebug");
  });
});
