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

import {
  creatorFeeGstPercentForInvite,
  creatorFeeGstPercentFromSettings,
  creatorPayoutBreakdown,
} from "./fee-rates.util";

describe("creator payout fee + GST", () => {
  it("₹1,000 at 2% + 18% → ₹976.40; 2.5% → ₹970.50; Premium 1% → ₹988.20", () => {
    expect(creatorPayoutBreakdown(100000, 2, 18)).toEqual({ fee: 2000, gst: 360, payout: 97640 });
    expect(creatorPayoutBreakdown(100000, 2.5, 18)).toEqual({ fee: 2500, gst: 450, payout: 97050 });
    expect(creatorPayoutBreakdown(100000, 1, 18)).toEqual({ fee: 1000, gst: 180, payout: 98820 });
    expect(creatorPayoutBreakdown(100000, 0, 18)).toEqual({ fee: 0, gst: 0, payout: 100000 });
  });

  it("charges GST on the creator fee only when commission AND the creator-GST switch are on", () => {
    expect(creatorFeeGstPercentFromSettings({ platformFeeEnabled: true, gstin: "36ABCDE1234F1Z1", gstPercent: 18 })).toBe(0);
    expect(creatorFeeGstPercentFromSettings({ platformFeeEnabled: false, creatorFeeGstEnabled: true, gstin: "36ABCDE1234F1Z1", gstPercent: 18 })).toBe(0);
    expect(creatorFeeGstPercentFromSettings({ platformFeeEnabled: true, creatorFeeGstEnabled: true, gstin: "36ABCDE1234F1Z1", gstPercent: 18 })).toBe(18);
  });

  it("uses the GST locked at acceptance; older accepted invites stay at 0", () => {
    expect(creatorFeeGstPercentForInvite({ recipientFeeGstPercent: 18 }, 0)).toBe(18);
    expect(creatorFeeGstPercentForInvite({ recipientFeePercent: 2 }, 18)).toBe(0);
    expect(creatorFeeGstPercentForInvite({}, 18)).toBe(18); // not accepted yet → today's rate
  });
});

import { effectiveGstPercent, gstinCheckChar, isValidGstin } from "./fee-rates.util";

describe("no GST without a GST registration", () => {
  it("validates the GSTIN format", () => {
    expect(isValidGstin("36ABCDE1234F1Z1")).toBe(true);
    expect(isValidGstin(" 36abcde1234f1z1 ")).toBe(true); // normalized
    expect(isValidGstin("ABCDE1234F")).toBe(false); // a PAN, not a GSTIN
    expect(isValidGstin("")).toBe(false);
  });

  it("charges 0% GST without a valid GSTIN, whatever the GST % says", () => {
    expect(effectiveGstPercent({ gstPercent: 18 })).toBe(0);
    expect(effectiveGstPercent({ gstPercent: 18, gstin: "not-a-gstin" })).toBe(0);
    expect(effectiveGstPercent({ gstPercent: 18, gstin: "36ABCDE1234F1Z1" })).toBe(18);
  });
});

describe("GSTIN check character", () => {
  it("accepts a real GSTIN and refuses a one-character typo", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false); // wrong check char
    expect(isValidGstin("27AAPFU0938F1ZV")).toBe(false); // typo in the PAN part
  });
});

import { applyCommissionOverride, hostCommissionPercentFromSettings } from "./fee-rates.util";

describe("host commission by role and plan", () => {
  const settings = {
    platformFeePercent: 9,
    brandFeePercent: 5,
    brandFeePercentPremium: 3,
    influencerFeePercent: 5,
    influencerFeePercentPremium: 3,
    photographerFeePercent: 5,
  };

  it("uses the role's Free rate, or its Premium rate when Premium", () => {
    expect(hostCommissionPercentFromSettings(settings, "brand", false)).toBe(5);
    expect(hostCommissionPercentFromSettings(settings, "brand", true)).toBe(3);
    expect(hostCommissionPercentFromSettings(settings, "influencer", true)).toBe(3);
    // No Premium rate set → the Free rate.
    expect(hostCommissionPercentFromSettings(settings, "photographer", true)).toBe(5);
  });

  it("falls back like the payment does: brand → global rate, creator hosts → 0", () => {
    expect(hostCommissionPercentFromSettings({ platformFeePercent: 9 }, "brand", false)).toBe(9);
    expect(hostCommissionPercentFromSettings({}, "brand", false)).toBe(10);
    expect(hostCommissionPercentFromSettings({ platformFeePercent: 9 }, "influencer", false)).toBe(0);
  });

  it("applies an admin override only while enabled and in its window", () => {
    const now = new Date("2026-10-29");
    expect(applyCommissionOverride(5, { enabled: true, overrideType: "waiver" }, now)).toBe(0);
    expect(applyCommissionOverride(10, { enabled: true, overrideType: "discount", value: 40 }, now)).toBe(6);
    expect(applyCommissionOverride(5, { enabled: true, overrideType: "fixed", value: 2 }, now)).toBe(2);
    expect(applyCommissionOverride(5, { enabled: false, overrideType: "waiver" }, now)).toBe(5);
    expect(
      applyCommissionOverride(5, { enabled: true, overrideType: "waiver", validUntil: "2026-10-01" }, now),
    ).toBe(5);
  });
});
