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
});
