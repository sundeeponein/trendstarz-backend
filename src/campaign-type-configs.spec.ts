import {
  getCampaignTypeConfigDefaults,
  resolveCampaignTypeConfigs,
} from "./campaign-type-configs";

describe("campaign-type-configs", () => {
  it("reads the default baseline from admin-config.json", () => {
    const items = getCampaignTypeConfigDefaults();

    expect(items.length).toBeGreaterThan(0);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerType: "brand",
          key: "paid_collab",
          label: "Paid Collab",
          sortOrder: 10,
        }),
        expect.objectContaining({
          ownerType: "photographer",
          key: "creative_project",
          label: "Creative Project",
          sortOrder: 60,
        }),
      ]),
    );
  });

  it("merges partial overrides with defaults", () => {
    const items = resolveCampaignTypeConfigs([
      {
        ownerType: "brand",
        key: "paid_collab",
        label: "Brand Paid Collab",
        enabled: false,
        premiumOnly: true,
        sortOrder: 5,
      },
    ]);

    expect(items).toEqual(
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
        expect.objectContaining({
          ownerType: "photographer",
          key: "reel_collab",
          label: "Reel Collaboration",
        }),
      ]),
    );
  });

  it("preserves explicit sort order changes in overrides", () => {
    const items = resolveCampaignTypeConfigs([
      {
        ownerType: "photographer",
        key: "creative_project",
        label: "Creative Project",
        enabled: true,
        premiumOnly: false,
        sortOrder: 1,
      },
      {
        ownerType: "photographer",
        key: "paid_collab",
        label: "Paid Shoot",
        enabled: true,
        premiumOnly: false,
        sortOrder: 20,
      },
    ]);

    const creativeProject = items.find(
      (item) => item.ownerType === "photographer" && item.key === "creative_project",
    );
    const paidShoot = items.find(
      (item) => item.ownerType === "photographer" && item.key === "paid_collab",
    );

    expect(creativeProject?.sortOrder).toBe(1);
    expect(paidShoot?.sortOrder).toBe(20);
    expect(items.indexOf(creativeProject!)).toBeLessThan(items.indexOf(paidShoot!));
  });
});