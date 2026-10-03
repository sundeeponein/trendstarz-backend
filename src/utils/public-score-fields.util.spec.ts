import { publicScoreFields } from "./public-score-fields.util";

describe("publicScoreFields", () => {
  const audit = {
    collaborationScore: 39,
    campaignReadiness: "Not Ready",
    trendstarzRecommended: false,
    pricingSuggestion: { reelPrice: 200, videoPrice: 900 },
  };

  it("never exposes the suggested price range", () => {
    expect(publicScoreFields(audit, true)).not.toHaveProperty("suggestedPriceRange");
    expect(publicScoreFields(audit, false)).not.toHaveProperty("suggestedPriceRange");
  });

  it("hides the score and negative readiness from guests", () => {
    expect(publicScoreFields(audit, false)).toEqual({
      collaborationScore: null,
      campaignReadiness: null,
      trendstarzRecommended: false,
    });
  });

  it("keeps positive readiness for guests", () => {
    const ready = { ...audit, collaborationScore: 85, campaignReadiness: "Campaign Ready" };
    expect(publicScoreFields(ready, false).campaignReadiness).toBe("Campaign Ready");
    expect(publicScoreFields(ready, false).collaborationScore).toBeNull();
  });

  it("gives logged-in viewers the score and full readiness", () => {
    expect(publicScoreFields(audit, true)).toEqual({
      collaborationScore: 39,
      campaignReadiness: "Not Ready",
      trendstarzRecommended: false,
    });
  });
});
