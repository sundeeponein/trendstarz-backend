import { CampaignInvitesService } from "./campaign-invites.service";

/** lockCreatorPayoutFee: fee % + GST % fixed on the invite (used by counter-offer acceptance). */
describe("creator payout fee lock", () => {
  const make = (settings: any, recipient: any) => {
    const svc: any = Object.create(CampaignInvitesService.prototype);
    svc.appSettingsModel = {
      findOne: () => ({ select: () => ({ lean: () => Promise.resolve(settings) }) }),
    };
    svc.loadRecipientProfile = jest.fn().mockResolvedValue(recipient);
    return svc;
  };
  const rates = { platformFeeEnabled: true, influencerRecipientFeePercent: 2, influencerRecipientFeePercentPremium: 1, photographerRecipientFeePercent: 2.5, gstin: "36ABCDE1234F1Z1", gstPercent: 18 };

  it("locks the Free rate and GST (switch on)", async () => {
    const invite: any = {};
    await make({ ...rates, creatorFeeGstEnabled: true }, { isPremium: false }).lockCreatorPayoutFee(invite, "influencer", "c1");
    expect(invite).toEqual({ recipientFeePercent: 2, recipientFeeGstPercent: 18 });
  });

  it("locks the Premium rate for a Premium creator", async () => {
    const invite: any = {};
    await make({ ...rates, creatorFeeGstEnabled: true }, { isPremium: true, premiumEnd: new Date(Date.now() + 86400000) }).lockCreatorPayoutFee(invite, "influencer", "c1");
    expect(invite.recipientFeePercent).toBe(1);
  });

  it("locks GST 0 while the switch is off, and 0/0 while creator fees are 0", async () => {
    const a: any = {};
    await make(rates, { isPremium: false }).lockCreatorPayoutFee(a, "photographer", "p1");
    expect(a).toEqual({ recipientFeePercent: 2.5, recipientFeeGstPercent: 0 });
    const b: any = {};
    await make({ platformFeeEnabled: true, gstin: "36ABCDE1234F1Z1", gstPercent: 18, creatorFeeGstEnabled: true }, {}).lockCreatorPayoutFee(b, "influencer", "c1");
    expect(b).toEqual({ recipientFeePercent: 0, recipientFeeGstPercent: 0 });
  });
});
