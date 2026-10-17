import { PublicCampaignTypeConfigsController } from "./public-lists.controller";

describe("PublicCampaignTypeConfigsController", () => {
  it("returns resolved campaign type configs from settings", async () => {
    const appSettingsModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          campaignTypeConfigs: [
            {
              ownerType: "brand",
              key: "paid_collab",
              label: "Brand Paid Collab",
              enabled: false,
              premiumOnly: true,
              sortOrder: 5,
            },
          ],
        }),
      }),
    };

    const controller = new PublicCampaignTypeConfigsController(
      appSettingsModel as any,
    );

    const result = await controller.get();

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerType: "brand",
          key: "paid_collab",
          label: "Brand Paid Collab",
          enabled: false,
          premiumOnly: true,
          sortOrder: 5,
        }),
        expect.objectContaining({
          ownerType: "photographer",
          key: "creative_project",
          label: "Creative Project",
        }),
      ]),
    );
  });
});