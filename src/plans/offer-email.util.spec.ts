import { defaultOfferBenefits, offerEndsLabel, offerUnsubscribeToken, verifyOfferUnsubscribeToken } from "./offer-email.util";
import { offerEmailTemplate } from "../email/templates/offer.templates";

describe("offer email helpers", () => {
  it("lists only what Premium really adds: lower fee, higher limits, extra features", () => {
    const pro = {
      limits: [
        { key: "maxInvitesReceivedPerMonth", label: "Invites / month", value: 5 },
        { key: "maxProfileImages", label: "Profile images", value: 3 },
        { key: "maxCampaignPosts", label: "Campaign posts", value: -1 },
      ],
      features: [
        { key: "priorityListing", label: "Priority search ranking", value: true },
        { key: "publicProfileListing", label: "Public profile listing", value: true },
      ],
    };
    const free = {
      limits: [
        { key: "maxInvitesReceivedPerMonth", value: 2 },
        { key: "maxProfileImages", value: 3 },
        { key: "maxCampaignPosts", value: 1 },
      ],
      features: [{ key: "publicProfileListing", value: true }],
    };
    const settings = { platformFeeEnabled: true, influencerRecipientFeePercent: 5, influencerRecipientFeePercentPremium: 3 };
    expect(defaultOfferBenefits(pro, free, settings, "influencer")).toEqual([
      "Lower platform fee on paid collaborations (3% instead of 5%)",
      "Invites / month: 5 (Free: 2)",
      "Campaign posts: Unlimited (Free: 1)",
      "Priority search ranking",
    ]);
    // No Premium rate set, or fees off → no fee claim.
    expect(defaultOfferBenefits(pro, free, { platformFeeEnabled: false }, "influencer")[0]).toBe("Invites / month: 5 (Free: 2)");
  });

  it("says the offer ends at 11:59 PM IST on the admin's date", () => {
    expect(offerEndsLabel(new Date("2026-11-10T18:29:59.999Z"))).toBe("10 November, 11:59 PM IST");
  });

  it("accepts only its own signed unsubscribe token", () => {
    const id = "64b7f0c2a1b2c3d4e5f60718";
    const t = offerUnsubscribeToken("influencer", id, "s".repeat(40));
    expect(verifyOfferUnsubscribeToken(t, "s".repeat(40))).toEqual({ role: "influencer", id });
    expect(verifyOfferUnsubscribeToken(t, "x".repeat(40))).toBeNull();
    expect(verifyOfferUnsubscribeToken(t.replace("influencer", "brand"), "s".repeat(40))).toBeNull();
  });

  it("escapes names and benefit lines in the email", () => {
    const mail = offerEmailTemplate({
      kind: "launch",
      recipientName: "<b>x</b>",
      offerName: "Diwali Offer",
      yearlyOfferPrice: "₹947",
      yearlyPrice: "₹3,789",
      endsAtLabel: "10 November, 11:59 PM IST",
      benefits: ['<a href="javascript:x">hi</a>'],
      upgradeUrl: "https://trendstarz.in/upgrade-premium",
      unsubscribeUrl: "https://trendstarz.in/offer-emails/unsubscribe?t=a",
    });
    expect(mail.html).not.toContain("<b>x</b>");
    expect(mail.html).not.toContain('<a href="javascript');
    expect(mail.subject).toBe("Diwali Offer: Premium Creator Membership at ₹947/year");
    expect(mail.text).toContain("No refunds once activated");
    expect(mail.text).toContain("Stop offer emails: https://trendstarz.in/offer-emails/unsubscribe?t=a");
  });
});
