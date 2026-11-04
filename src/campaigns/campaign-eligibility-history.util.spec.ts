import {
  campaignLiveAt,
  currentEligibilityProfile,
  eligibilityChanges,
  eligibilityProfileAsOf,
  openCampaignProfileRefusal,
} from "./campaign-eligibility-history.util";

const LIVE = new Date("2026-11-10T06:00:00Z");
const campaign = { targetState: "Telangana", categories: ["Travel"], liveAt: LIVE };

function creator(state: string, categories: string[], history: any[] = []) {
  return { location: { state, district: "" }, categories, eligibilityHistory: history };
}

describe("open campaign eligibility as of go-live", () => {
  it("records state, district and niche changes, ignoring case and order", () => {
    const before = currentEligibilityProfile(creator("Andhra Pradesh", ["Food", "Travel"]));
    expect(eligibilityChanges(before, { ...before, categories: ["travel", "food"] })).toEqual([]);
    const changes = eligibilityChanges(before, { state: "Telangana", district: "Hyderabad", categories: ["Travel"] });
    expect(changes.map((c) => c.field)).toEqual(["state", "district", "categories"]);
  });

  it("lets in a creator who already matched before go-live", () => {
    expect(openCampaignProfileRefusal(creator("Telangana", ["Travel"]), campaign)).toBeNull();
  });

  it("refuses a niche switched after go-live, explaining why", () => {
    const c = creator("Telangana", ["Travel"], [
      { field: "categories", from: ["Food"], to: ["Travel"], changedAt: new Date("2026-11-12T00:00:00Z") },
    ]);
    expect(eligibilityProfileAsOf(c, LIVE).categories).toEqual(["Food"]);
    expect(openCampaignProfileRefusal(c, campaign)).toContain("after this campaign went live");
    // A campaign that went live after the change counts it.
    expect(openCampaignProfileRefusal(c, { ...campaign, liveAt: new Date("2026-11-13T00:00:00Z") })).toBeNull();
  });

  it("refuses a first niche added after go-live", () => {
    const c = creator("Telangana", ["Travel"], [
      { field: "categories", from: [], to: ["Travel"], changedAt: new Date("2026-11-12T00:00:00Z") },
    ]);
    expect(openCampaignProfileRefusal(c, campaign)).toContain("after this campaign went live");
  });

  it("refuses a move into the state after go-live", () => {
    const c = creator("Telangana", ["Travel"], [
      { field: "state", from: "Andhra Pradesh", to: "Telangana", changedAt: new Date("2026-11-11T00:00:00Z") },
    ]);
    expect(openCampaignProfileRefusal(c, campaign)).toContain("after this campaign went live");
  });

  it("undoes several later changes newest first", () => {
    const c = creator("Telangana", ["Travel"], [
      { field: "categories", from: ["Food"], to: ["Beauty"], changedAt: new Date("2026-11-11T00:00:00Z") },
      { field: "categories", from: ["Beauty"], to: ["Travel"], changedAt: new Date("2026-11-12T00:00:00Z") },
    ]);
    expect(eligibilityProfileAsOf(c, LIVE).categories).toEqual(["Food"]);
  });

  it("gives the normal reason when the creator never matched", () => {
    expect(openCampaignProfileRefusal(creator("Telangana", ["Tech"]), campaign)).toBe(
      "This campaign is only for Travel creators.",
    );
  });

  it("falls back to createdAt for campaigns approved before liveAt existed", () => {
    expect(campaignLiveAt({ createdAt: "2026-10-01T00:00:00Z" })?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
