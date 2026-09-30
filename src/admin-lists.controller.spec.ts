import { AdminListsController } from "./admin-lists.controller";

describe("AdminListsController", () => {
  function createController(settingsDoc: any = null) {
    const appSettingsModel = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(settingsDoc),
      }),
      findOneAndUpdate: jest.fn(),
    };

    // Constructor order (admin-lists.controller.ts): 16 models (AppSettings is the
    // 15th, index 14) then 4 services. Only AppSettings matters for these tests.
    const APP_SETTINGS_INDEX = 14;
    const args: any[] = Array.from({ length: 20 }, () => ({}));
    args[APP_SETTINGS_INDEX] = appSettingsModel;
    const controller = new (AdminListsController as any)(...args) as AdminListsController;

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

  describe("forceCompleteCampaign → campaign_completed", () => {
    const CAMPAIGN_MODEL_INDEX = 10;
    const CAMPAIGNS_SERVICE_INDEX = 19;

    function createWithCampaign(campaign: any) {
      const args: any[] = Array.from({ length: 20 }, () => ({}));
      args[CAMPAIGN_MODEL_INDEX] = {
        findById: jest.fn().mockResolvedValue(campaign),
      };
      const campaignsService = {
        recordCampaignCompleted: jest.fn().mockResolvedValue(undefined),
      };
      args[CAMPAIGNS_SERVICE_INDEX] = campaignsService;
      const controller = new (AdminListsController as any)(
        ...args,
      ) as AdminListsController;
      return { controller, campaignsService };
    }

    it("records campaign_completed with the admin as actor after saving", async () => {
      const campaign: any = { _id: "c1", status: "active" };
      campaign.save = jest.fn().mockResolvedValue(campaign);
      const { controller, campaignsService } = createWithCampaign(campaign);

      await controller.forceCompleteCampaign(
        "c1",
        { reason: "Brand confirmed all deliverables were received." } as any,
        { user: { userId: "64b0000000000000000000aa" } },
      );

      expect(campaign.save).toHaveBeenCalled();
      expect(campaignsService.recordCampaignCompleted).toHaveBeenCalledWith(
        campaign,
        {
          userId: "64b0000000000000000000aa",
          userRole: "admin",
        },
      );
    });

    it("records nothing when the campaign is not active", async () => {
      const campaign: any = { _id: "c1", status: "draft", save: jest.fn() };
      const { controller, campaignsService } = createWithCampaign(campaign);

      await expect(
        controller.forceCompleteCampaign(
          "c1",
          { reason: "Brand confirmed all deliverables." } as any,
          { user: {} },
        ),
      ).rejects.toThrow();
      expect(campaignsService.recordCampaignCompleted).not.toHaveBeenCalled();
    });
  });

  describe("cancelCampaignParticipation → invite_withdrawn(admin_cancel)", () => {
    const CAMPAIGN_MODEL_INDEX = 10;
    const INVITE_MODEL_INDEX = 11;
    const PLATFORM_EVENTS_INDEX = 20;
    const queryOf = (value: any) => ({
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }),
    });

    function setup(snapshot: any[], confirmed: any[]) {
      const campaign: any = { _id: "c1", status: "active" };
      campaign.save = jest.fn().mockResolvedValue(campaign);
      const inviteModel = {
        find: jest
          .fn()
          .mockReturnValueOnce(queryOf(snapshot))
          .mockReturnValueOnce(queryOf(confirmed)),
        updateMany: jest
          .fn()
          .mockResolvedValue({ modifiedCount: confirmed.length }),
      };
      const platformEvents = { record: jest.fn().mockResolvedValue(true) };
      const args: any[] = Array.from({ length: 21 }, () => ({}));
      args[CAMPAIGN_MODEL_INDEX] = {
        findById: jest.fn().mockResolvedValue(campaign),
      };
      args[INVITE_MODEL_INDEX] = inviteModel;
      args[PLATFORM_EVENTS_INDEX] = platformEvents;
      const controller = new (AdminListsController as any)(
        ...args,
      ) as AdminListsController;
      return { controller, campaign, inviteModel, platformEvents };
    }

    const reason = {
      reason: "Brand requested emergency stop for this campaign.",
    } as any;
    const req = { user: { userId: "64b0000000000000000000aa" } };

    it("records admin_cancel for each invite the override actually withdrew", async () => {
      const { controller, platformEvents, inviteModel } = setup(
        [
          {
            _id: "i1",
            status: "pending",
            campaignId: "c1",
            influencerId: "u1",
          },
          {
            _id: "i2",
            status: "accepted",
            campaignId: "c1",
            influencerId: "u2",
          },
        ],
        [{ _id: "i1" }], // i2 moved on (e.g. payment confirmed) before the update
      );

      const res: any = await controller.cancelCampaignParticipation(
        "c1",
        reason,
        req,
      );

      expect(res.cancelledInvites).toBe(1);
      expect(inviteModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          status: { $in: ["pending", "invited", "counter_sent", "accepted"] },
        }),
        { $set: { status: "withdrawn" } },
      );
      expect(platformEvents.record).toHaveBeenCalledTimes(1);
      expect(platformEvents.record.mock.calls[0][0]).toMatchObject({
        eventType: "invite_withdrawn",
        inviteId: "i1",
        userId: "64b0000000000000000000aa",
        userRole: "admin",
        dedupeKey: "invite_withdrawn:i1",
        metadata: { reason: "admin_cancel", previousStatus: "pending" },
      });
    });

    it("still cancels when the snapshot lookup fails", async () => {
      const { controller, campaign, inviteModel, platformEvents } = setup(
        [],
        [],
      );
      inviteModel.find = jest.fn(() => {
        throw new Error("db blip");
      });
      await controller.cancelCampaignParticipation("c1", reason, req);
      expect(inviteModel.updateMany).toHaveBeenCalled();
      expect(campaign.status).toBe("cancelled");
      expect(platformEvents.record).not.toHaveBeenCalled();
    });
  });
});
