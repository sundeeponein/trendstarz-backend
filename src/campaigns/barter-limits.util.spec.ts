import {
  barterLimitsFrom,
  capBarterAcceptance,
  isBarterOrLocationCampaign,
} from "./barter-limits.util";

describe("barter/location limits", () => {
  it("product-only and location are barter; product + paid and paid collab are not", () => {
    expect(isBarterOrLocationCampaign({ campaignType: "invite_location" })).toBe(true);
    expect(isBarterOrLocationCampaign({ campaignType: "product", productPaymentMode: "product_only" })).toBe(true);
    expect(isBarterOrLocationCampaign({ campaignType: "product" })).toBe(true);
    expect(isBarterOrLocationCampaign({ campaignType: "product", productPaymentMode: "product_plus_payment" })).toBe(false);
    expect(isBarterOrLocationCampaign({ campaignType: "paid_collab" })).toBe(false);
  });

  it("uses defaults 2 / 3 / 1 when the plan doesn't set them, and plan values when it does", () => {
    expect(barterLimitsFrom([])).toEqual({ perMonth: 2, invitesPerCampaign: 3, acceptedPerCampaign: 1 });
    expect(
      barterLimitsFrom([
        { key: "maxBarterCampaignsPerMonth", value: 1 },
        { key: "maxInvitesPerBarterCampaign", value: 5 },
        { key: "maxAcceptedPerBarterCampaign", value: -1 },
      ]),
    ).toEqual({ perMonth: 1, invitesPerCampaign: 5, acceptedPerCampaign: -1 });
  });

  it("caps accepted creators on a barter campaign, including role slots", () => {
    const c = {
      campaignType: "invite_location",
      maxInfluencers: 5,
      minInfluencers: 2,
      inviteSlots: [{ role: "influencer", count: 4 }],
    };
    const out = capBarterAcceptance({} as any, c, 1);
    expect(out.maxInfluencers).toBe(1);
    expect(out.minInfluencers).toBe(1);
    expect(out.inviteSlots[0].count).toBe(1);
  });

  it("leaves paid campaigns and an unlimited cap alone", () => {
    expect(capBarterAcceptance({} as any, { campaignType: "paid_collab", maxInfluencers: 5 }, 1)).toEqual({});
    expect(capBarterAcceptance({} as any, { campaignType: "product", maxInfluencers: 5 }, -1)).toEqual({});
  });
});
