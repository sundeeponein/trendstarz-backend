import { MonetizationService } from "./monetization.service";

describe("invite unlock order", () => {
  const invite = { _id: "i1", brandId: "host1", influencerId: "creator1", status: "accepted", campaignId: "c1" };
  const ctx = (campaign: any = null) => ({
    inviteModel: { findById: () => ({ lean: async () => invite }) },
    campaignModel: { findById: () => ({ lean: async () => campaign }) },
  });
  const order = (c: any, payerId: string) =>
    (MonetizationService.prototype as any).createInviteUnlockOrder.call(c, { inviteId: "i1", payerId, payerRole: "brand" });

  it("refuses someone who isn't the invite's host or creator", async () => {
    await expect(order(ctx(), "stranger")).rejects.toThrow("Invite not found");
  });

  it("lets the host through to the next checks", async () => {
    // Campaign lookup is the next step; null campaign → "Campaign not found" proves the party check passed.
    await expect(order(ctx(null), "host1")).rejects.toThrow("Campaign not found");
  });
});
