import { AdminListsController } from "./admin-lists.controller";

describe("AdminListsController", () => {
  function createController(settingsDoc: any = null) {
    const appSettingsModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(settingsDoc),
      }),
      findOneAndUpdate: jest.fn(),
    };

    const controller = new AdminListsController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      appSettingsModel as any,
    );

    return { controller, appSettingsModel };
  }

  it("returns campaignTypeConfigDefaults in admin settings payload", async () => {
    const { controller } = createController();

    const result = await controller.getSettings();

    expect(result.campaignTypeConfigDefaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerType: "brand",
          key: "paid_collab",
          label: "Paid Collab",
        }),
        expect.objectContaining({
          ownerType: "photographer",
          key: "creative_project",
          label: "Creative Project",
        }),
      ]),
    );
    expect(result.campaignTypeConfigs).toEqual(result.campaignTypeConfigDefaults);
  });

  it("normalizes persisted campaignTypeConfigs against defaults", async () => {
    const { controller } = createController({
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
    });

    const result = await controller.getSettings();

    expect(result.campaignTypeConfigs).toEqual(
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
          ownerType: "brand",
          key: "product",
          label: "Product Collab",
        }),
      ]),
    );
    expect(result.campaignTypeConfigDefaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerType: "brand",
          key: "paid_collab",
          label: "Paid Collab",
        }),
      ]),
    );
  });

  it("normalizes and persists campaignTypeConfigs on settings update", async () => {
    const { controller, appSettingsModel } = createController();
    appSettingsModel.findOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        campaignTypeConfigs: [
          {
            ownerType: "photographer",
            key: "creative_project",
            label: "Creative Project",
            enabled: true,
            premiumOnly: false,
            sortOrder: 1,
          },
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
    });

    const result = await controller.updateSettings({
      campaignTypeConfigs: [
        {
          ownerType: "photographer",
          key: "creative_project",
          label: "Creative Project",
          enabled: true,
          premiumOnly: false,
          sortOrder: 1,
        },
        {
          ownerType: "brand",
          key: "paid_collab",
          label: "Brand Paid Collab",
          enabled: false,
          premiumOnly: true,
          sortOrder: 5,
        },
        {
          ownerType: "brand",
          key: "not_allowed",
          label: "Ignore me",
          enabled: true,
          premiumOnly: false,
          sortOrder: 999,
        },
      ],
    });

    expect(appSettingsModel.findOneAndUpdate).toHaveBeenCalledWith(
      {},
      {
        $set: {
          campaignTypeConfigs: expect.arrayContaining([
            expect.objectContaining({
              ownerType: "photographer",
              key: "creative_project",
              sortOrder: 1,
            }),
            expect.objectContaining({
              ownerType: "brand",
              key: "paid_collab",
              label: "Brand Paid Collab",
              enabled: false,
              premiumOnly: true,
              sortOrder: 5,
            }),
            expect.objectContaining({
              ownerType: "brand",
              key: "product",
              label: "Product Collab",
            }),
          ]),
        },
      },
      { upsert: true, new: true },
    );
    expect(
      appSettingsModel.findOneAndUpdate.mock.calls[0][1].$set.campaignTypeConfigs,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "not_allowed" }),
      ]),
    );
    expect(result).toEqual({
      success: true,
      settings: {
        campaignTypeConfigs: [
          {
            ownerType: "photographer",
            key: "creative_project",
            label: "Creative Project",
            enabled: true,
            premiumOnly: false,
            sortOrder: 1,
          },
          {
            ownerType: "brand",
            key: "paid_collab",
            label: "Brand Paid Collab",
            enabled: false,
            premiumOnly: true,
            sortOrder: 5,
          },
        ],
      },
    });
  });
});