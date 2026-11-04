import mongoose from "mongoose";
import { CampaignSchema } from "../database/schemas/profile.schemas";
import { CampaignsService } from "./campaigns.service";

/** Field locks compared against the real campaign schema (no database needed). */
describe("campaign field locks — unchanged values are not 'changes'", () => {
  const Campaign =
    mongoose.models.FieldLockCampaign ||
    mongoose.model("FieldLockCampaign", CampaignSchema);
  const inviteModel = { countDocuments: jest.fn().mockResolvedValue(0) };
  // Constructor only stores its dependencies; the two models are all these checks use.
  const service: any = new (CampaignsService as any)(
    Campaign,
    inviteModel,
    ...Array(20).fill({}),
  );

  const rateCard = [
    { platform: "instagram", contentTypes: [{ name: "Reel", enabled: true, price: 500 }] },
  ];
  const stored = new Campaign({ status: "active", socialMedia: rateCard });

  it("the same socialMedia sent back by the form is unchanged (schema defaults ignored)", () => {
    expect(service.sameCampaignValue(stored, "socialMedia", rateCard)).toBe(true);
  });

  it("a changed price is still a change", () => {
    const changed = [
      { platform: "instagram", contentTypes: [{ name: "Reel", enabled: true, price: 900 }] },
    ];
    expect(service.sameCampaignValue(stored, "socialMedia", changed)).toBe(false);
  });

  it("an approved campaign accepts a save that only re-sends locked fields unchanged", async () => {
    const campaign = new Campaign({ status: "active", title: "Launch", socialMedia: rateCard });
    await expect(
      service.assertEditableFields(campaign, { title: "Launch", socialMedia: rateCard }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertEditableFields(campaign, { title: "Renamed", socialMedia: rateCard }),
    ).rejects.toThrow('"title" cannot be changed after the campaign is approved.');
  });

  describe("audience locks (community posts quote these)", () => {
    const live = () =>
      new Campaign({
        status: "active",
        targetState: "Telangana",
        targetDistrict: "Hyderabad",
        minInfluencerTier: "Mid-Tier",
        campaignMode: "tier_filtered_open",
        categories: ["Travel"],
      });

    it("lets the form re-send the same audience in any case or order", async () => {
      await expect(
        service.assertTargetingLocked(live(), { targetState: "telangana", targetDistrict: "Hyderabad", minInfluencerTier: "Mid-Tier", campaignMode: "tier_filtered_open", categories: ["travel"] }),
      ).resolves.toBeUndefined();
    });

    it("refuses state, district, tier and mode changes once live", async () => {
      for (const change of [
        { targetState: "Andhra Pradesh" },
        { targetDistrict: "" },
        { minInfluencerTier: "Micro" },
        { campaignMode: "invite_only" },
      ]) {
        await expect(service.assertTargetingLocked(live(), change)).rejects.toThrow("can't be changed after the campaign is approved");
      }
    });

    it("lets niches change until a creator is accepted", async () => {
      inviteModel.countDocuments.mockResolvedValueOnce(0);
      await expect(service.assertTargetingLocked(live(), { categories: ["Travel", "Food"] })).resolves.toBeUndefined();
      inviteModel.countDocuments.mockResolvedValueOnce(1);
      await expect(service.assertTargetingLocked(live(), { categories: ["Food"] })).rejects.toThrow(
        "Niche can't be changed after a creator has been accepted.",
      );
    });

    it("leaves drafts and campaigns in review editable", async () => {
      const draft = live();
      draft.status = "pending_review";
      await expect(service.assertTargetingLocked(draft, { targetState: "Goa" })).resolves.toBeUndefined();
    });

    it("stamps liveAt the first time a campaign is active", async () => {
      const c = new Campaign({ title: "x", status: "active" });
      await c.validate().catch(() => undefined);
      expect(c.liveAt).toBeInstanceOf(Date);
    });
  });
});
