import { campaignNicheRefusal, matchesCampaignNiche } from "./campaign-niche.util";

describe("open campaign niche rule", () => {
  const campaign = { categories: ["Travel", "Food", "Beauty"] };

  it("lets every niche in when the host picked none", () => {
    expect(matchesCampaignNiche({ categories: [] }, [])).toBe(true);
    expect(matchesCampaignNiche({}, ["Tech"])).toBe(true);
  });

  it("needs at least one shared niche (case-insensitive)", () => {
    expect(matchesCampaignNiche(campaign, ["travel"])).toBe(true);
    expect(matchesCampaignNiche(campaign, ["Tech", " Food "])).toBe(true);
    expect(matchesCampaignNiche(campaign, ["Tech"])).toBe(false);
  });

  it("hides niche-limited campaigns from creators with no niche", () => {
    expect(matchesCampaignNiche(campaign, [])).toBe(false);
    expect(matchesCampaignNiche(campaign, undefined)).toBe(false);
    expect(campaignNicheRefusal(campaign, [])).toContain("Add your niche");
    expect(campaignNicheRefusal(campaign, ["Tech"])).toBe(
      "This campaign is only for Travel, Food, Beauty creators.",
    );
  });

  it("does not limit photographer campaigns", () => {
    expect(
      matchesCampaignNiche({ ...campaign, inviteRecipientRole: "photographer" }, []),
    ).toBe(true);
  });
});
