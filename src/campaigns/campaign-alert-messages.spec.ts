import {
  computeCampaignAlertFields,
  openCampaignLink,
  openCampaignWhatsAppParams,
  renderOpenCampaignMessage,
} from "./campaign-alert-messages";

describe("open campaign community message", () => {
  const env = { FRONTEND_URL: "https://trendstarz.in/" } as NodeJS.ProcessEnv;
  const base = {
    _id: "665f1c2b9d3e4a0012345678",
    title: "Hill Trip",
    campaignMode: "tier_filtered_open",
    campaignType: "paid_collab",
    targetState: "Telangana",
    pricePerInfluencer: 150000,
    minInfluencerTier: "Mid-Tier",
    categories: ["Travel", "Food"],
  };

  it("links straight to the campaign for creators", () => {
    expect(openCampaignLink(base, env)).toBe(
      "https://trendstarz.in/campaigns?open=665f1c2b9d3e4a0012345678",
    );
    expect(openCampaignLink({ ...base, inviteRecipientRole: "photographer" }, env)).toBe(
      "https://trendstarz.in/photographer-dashboard",
    );
  });

  it("shows niche and tier-and-above, no price and no login path", () => {
    const text = renderOpenCampaignMessage(computeCampaignAlertFields(base, 0));
    expect(text).not.toContain("₹");
    expect(text).not.toContain("Paid");
    expect(text).toContain("🎯 Niche: Travel, Food (only these niches can apply)");
    expect(text).toContain("🏆 Tier: Mid-Tier (10,001–1,00,000 followers) and above");
    expect(text).toContain("/campaigns?open=665f1c2b9d3e4a0012345678");
    expect(text).not.toContain("Login → Campaigns");
    expect(text).not.toContain("Only for creators in");
  });

  it("tags the community link for Google Analytics with the campaign code", () => {
    const text = renderOpenCampaignMessage(computeCampaignAlertFields({ ...base, campaignNumber: 30 }, 0));
    expect(text).toContain("/campaigns?open=665f1c2b9d3e4a0012345678&utm_source=whatsapp&utm_medium=community&utm_campaign=CMP-30");
  });

  it("warns when the campaign is limited to one district", () => {
    const text = renderOpenCampaignMessage(
      computeCampaignAlertFields({ ...base, targetDistrict: "Hyderabad" }, 0),
    );
    expect(text).toContain("📍 Location: Hyderabad, Telangana");
    expect(text).toContain("⚠️ Only for creators in Hyderabad district");
  });

  it("never shows product value or cash", () => {
    const text = renderOpenCampaignMessage(
      computeCampaignAlertFields(
        { ...base, campaignType: "product", productValue: 250000, productPaymentMode: "product_plus_payment", productPaymentAmount: 50000 },
        0,
      ),
    );
    expect(text).not.toContain("₹");
    expect(text).not.toContain("Product worth");
  });

  it("leaves the automatic template params unchanged (7 params)", () => {
    const params = openCampaignWhatsAppParams(computeCampaignAlertFields(base, 2));
    expect(params).toHaveLength(7);
    expect(params[3]).toBe("🏆 Minimum Tier: Mid-Tier");
  });
});

describe("campaign alert location", () => {
  it("shows the venue's area (never its name or address) for a location visit", () => {
    const fields = computeCampaignAlertFields(
      { title: "Cafe launch", campaignType: "invite_location", venueName: "Cafe Bloom", venueAddress: "Road No. 36", venueCity: "Hyderabad", venueState: "Telangana" },
      0,
    );
    expect(fields.location).toBe("Hyderabad, Telangana");
    expect(renderOpenCampaignMessage(fields)).not.toMatch(/Cafe Bloom|Road No/);
  });
});
