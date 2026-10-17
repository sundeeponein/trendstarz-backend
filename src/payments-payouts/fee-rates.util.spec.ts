import {
  isActivePremium,
  rateForPlan,
  recipientFeePercentFromSettings,
} from "./fee-rates.util";

describe("commission rates by plan", () => {
  it("Premium uses its own rate when set, otherwise the Free rate", () => {
    expect(rateForPlan(2, 1, true)).toBe(1);
    expect(rateForPlan(2, 1, false)).toBe(2);
    expect(rateForPlan(2, null, true)).toBe(2); // blank = same as Free
    expect(rateForPlan(2, 0, true)).toBe(0); // Premium can be fee-free
  });

  it("Premium is active only until premiumEnd", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    expect(isActivePremium({ isPremium: true }, now)).toBe(true);
    expect(isActivePremium({ isPremium: true, premiumEnd: "2026-12-01" }, now)).toBe(true);
    expect(isActivePremium({ isPremium: true, premiumEnd: "2026-10-01" }, now)).toBe(false);
    expect(isActivePremium({ isPremium: false }, now)).toBe(false);
  });

  it("creator payout fee: Free 2% / Premium 1%, and 0 while commission is off", () => {
    const settings = {
      platformFeeEnabled: true,
      influencerRecipientFeePercent: 2,
      influencerRecipientFeePercentPremium: 1,
      photographerRecipientFeePercent: 2.5,
    };
    expect(recipientFeePercentFromSettings(settings, "influencer", false)).toBe(2);
    expect(recipientFeePercentFromSettings(settings, "influencer", true)).toBe(1);
    expect(recipientFeePercentFromSettings(settings, "photographer", true)).toBe(2.5);
    expect(
      recipientFeePercentFromSettings({ ...settings, platformFeeEnabled: false }, "influencer", false),
    ).toBe(0);
  });
});
