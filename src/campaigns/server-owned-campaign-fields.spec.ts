import { withoutServerOwnedCampaignFields } from "./campaigns.service";

describe("withoutServerOwnedCampaignFields", () => {
  it("drops fields only the server may write, keeps the rest", () => {
    const clean = withoutServerOwnedCampaignFields({
      title: "Launch",
      pricePerInfluencer: 50000,
      status: "active", // status has its own transition checks; not stripped here
      brandId: "someone-else",
      campaignNumber: 1,
      moderatedBy: "admin",
      moderationNote: "approved",
      completedBy: "admin",
      adminOverrideAction: "force_complete",
      slotUsedAt: new Date(0),
      _id: "x",
    });
    expect(clean).toEqual({
      title: "Launch",
      pricePerInfluencer: 50000,
      status: "active",
    });
  });

  it("does not mutate the caller's object", () => {
    const body = { title: "A", brandId: "b" };
    withoutServerOwnedCampaignFields(body);
    expect(body).toEqual({ title: "A", brandId: "b" });
  });
});
