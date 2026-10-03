import { CampaignInvitesService } from "./campaign-invites.service";

/**
 * Open campaigns: the tier is a MINIMUM ("Micro" admits Micro and above), the
 * same rule as the campaign form label, alerts, dashboard and 3B-2 eligibility.
 */
describe("applyToCampaign — minimum tier is 'this tier or above'", () => {
  const PAST_TIER = "REACHED_AFTER_TIER_CHECK";
  // Any model call beyond the two lookups below means the tier check passed.
  const trap = () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(PAST_TIER);
        },
      },
    );

  function service(tier: string, campaignOver: Record<string, any> = {}) {
    const campaign = {
      _id: "c1",
      campaignMode: "tier_filtered_open",
      status: "active",
      platforms: ["Instagram"],
      minInfluencerTier: "Micro",
      ...campaignOver,
    };
    const influencer = {
      _id: "i1",
      socialMedia: [{ platform: "Instagram", platformKey: "instagram", tier }],
      location: {},
    };
    const args: any[] = [
      trap(), // inviteModel
      trap(), // submissionModel
      { findById: () => ({ lean: () => Promise.resolve(campaign) }) }, // campaignModel
      trap(), // brandModel
      trap(), // photographerModel
      { findById: () => ({ lean: () => Promise.resolve(influencer) }) }, // influencerModel
      trap(), // campaignTransactionModel
      trap(), // appSettingsModel
      trap(), // plansService
      trap(), // pushService
      trap(), // notificationsService
      trap(), // whatsAppService
      { assertCampaignEligible: () => Promise.resolve() }, // profileVerificationService
      trap(), // trackingLinksService
      trap(), // platformEvents
    ];
    return new (CampaignInvitesService as any)(
      ...args,
    ) as CampaignInvitesService;
  }

  const outcome = async (tier: string, over: Record<string, any> = {}) => {
    try {
      await service(tier, over).applyToCampaign("i1", "c1", "Instagram");
      return "passed";
    } catch (e: any) {
      return String(e?.message || e);
    }
  };

  it.each(["Micro", "Mid-Tier", "Macro", "Mega / Celebrity", "mid tier"])(
    "%s passes a Micro minimum",
    async (tier) => {
      const result = await outcome(tier);
      expect(result).not.toContain("tier or above");
      expect([PAST_TIER, "passed"]).toContain(result);
    },
  );

  it.each(["Nano", "Starter", ""])(
    "%p is refused with the minimum wording",
    async (tier) => {
      expect(await outcome(tier)).toBe(
        "This campaign requires Micro tier or above on Instagram.",
      );
    },
  );

  it("no minimum tier → no tier restriction", async () => {
    const result = await outcome("Starter", { minInfluencerTier: "" });
    expect(result).not.toContain("tier or above");
  });
});
