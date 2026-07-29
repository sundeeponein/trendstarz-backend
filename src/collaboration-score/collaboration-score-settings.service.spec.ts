import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";
import defaultSettingsJson from "./collaboration-score-settings.default.json";

describe("CollaborationScoreSettingsService", () => {
  let service: CollaborationScoreSettingsService;
  let settingsModel: any;
  let auditLogModel: any;

  beforeEach(() => {
    settingsModel = {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
      }),
      create: jest.fn().mockResolvedValue({ toObject: () => ({ ...defaultSettingsJson }) }),
      deleteMany: jest.fn().mockResolvedValue({}),
    };
    auditLogModel = { create: jest.fn().mockResolvedValue({}) };
    service = new CollaborationScoreSettingsService(settingsModel, auditLogModel);
  });

  it("returns the JSON file's defaults when no Mongo document exists yet", async () => {
    const settings = await service.getSettings();

    expect(settings.aiEnabled).toBe(defaultSettingsJson.aiEnabled);
    expect(settings.reanalysisFeeRupees).toBe(defaultSettingsJson.reanalysisFeeRupees);
    expect(settings.anonymousPreviewEnabled).toBe(defaultSettingsJson.anonymousPreviewEnabled);
    expect(settings.freeAuditCount).toBe(defaultSettingsJson.freeAuditCount);
    expect(settings.version1Name).toBe(defaultSettingsJson.version1Name);
    expect(settings.version2Name).toBe(defaultSettingsJson.version2Name);
    expect(settings.analytics).toEqual(defaultSettingsJson.analytics);
    expect(settings.scoreWeights).toEqual(defaultSettingsJson.scoreWeights);
    expect(settings.schemaVersion).toBe(defaultSettingsJson.schemaVersion);
  });

  it("normalize() falls back to defaults for out-of-range or missing values on a partial Mongo doc", async () => {
    settingsModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ freeAuditCount: 999, auditValidityDays: -5 }),
    });

    const settings = await service.getSettings();

    expect(settings.freeAuditCount).toBe(100); // clamped to max
    expect(settings.auditValidityDays).toBe(0); // clamped to min
    expect(settings.anonymousPreviewEnabled).toBe(true); // untouched field falls back to default
  });

  it("buildUpdate() only patches fields present in the request body", async () => {
    settingsModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    settingsModel.findOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ anonymousPreviewEnabled: false }),
    });

    await service.updateSettings({ anonymousPreviewEnabled: false });

    const [, update] = settingsModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set).toEqual({ anonymousPreviewEnabled: false });
  });

  it("buildUpdate() rejects a non-object payload", async () => {
    await expect(service.updateSettings(null)).rejects.toThrow("Settings payload must be an object");
  });

  describe("startup seeding", () => {
    it("onModuleInit inserts JSON defaults when the collection is empty", async () => {
      await service.onModuleInit();

      expect(settingsModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ aiModel: defaultSettingsJson.aiModel, schemaVersion: 1 }),
      );
    });

    it("onModuleInit never overwrites an existing document", async () => {
      settingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ aiEnabled: true }),
      });

      await service.onModuleInit();

      expect(settingsModel.create).not.toHaveBeenCalled();
    });

    it("onModuleInit deletes extra singleton documents, keeping only the most recently updated one", async () => {
      settingsModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([{ _id: "newest" }, { _id: "older-1" }, { _id: "older-2" }]),
          }),
        }),
      });
      settingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ aiEnabled: true }), // an existing doc — create() must not fire
      });

      await service.onModuleInit();

      expect(settingsModel.deleteMany).toHaveBeenCalledWith({ _id: { $in: ["older-1", "older-2"] } });
      expect(settingsModel.create).not.toHaveBeenCalled();
    });

    it("onModuleInit does nothing to the collection when 0 or 1 documents exist", async () => {
      settingsModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: "only-one" }]) }),
        }),
      });
      settingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ aiEnabled: true }),
      });

      await service.onModuleInit();

      expect(settingsModel.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("resetToDefaults", () => {
    it("deletes the current config, re-seeds, and logs the reset", async () => {
      settingsModel.findOne
        .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ aiEnabled: true }) }) // getSettings() "before" snapshot
        .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) }); // seedDefaults() sees it's gone

      const result = await service.resetToDefaults({ userId: "admin-1", role: "admin" });

      expect(settingsModel.deleteMany).toHaveBeenCalledWith({});
      expect(settingsModel.create).toHaveBeenCalled();
      expect(result.aiEnabled).toBe(defaultSettingsJson.aiEnabled);
      expect(auditLogModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: "settings_reset", actorId: "admin-1", actorRole: "admin" }),
      );
    });
  });

  describe("in-memory cache (5 min TTL)", () => {
    it("does not re-query Mongo on a second getSettings() call within the TTL", async () => {
      await service.getSettings();
      await service.getSettings();

      expect(settingsModel.findOne).toHaveBeenCalledTimes(1);
    });

    it("re-queries Mongo after updateSettings() invalidates the cache", async () => {
      settingsModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ aiEnabled: true }),
      });

      await service.getSettings();
      await service.updateSettings({ aiEnabled: true });
      await service.getSettings();

      expect(settingsModel.findOne).toHaveBeenCalledTimes(2);
    });
  });

  describe("DTO validation", () => {
    it("rejects an out-of-range freeAuditCount", async () => {
      await expect(service.updateSettings({ freeAuditCount: 500 })).rejects.toThrow();
      expect(settingsModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean aiEnabled", async () => {
      await expect(service.updateSettings({ aiEnabled: "yes" })).rejects.toThrow();
    });
  });

  describe("weights must sum to 100", () => {
    it("rejects scoreWeights that don't sum to 100", async () => {
      await expect(
        service.updateSettings({
          scoreWeights: {
            profileCompletion: 15,
            contentQuality: 25,
            postingConsistency: 20,
            professionalBranding: 20,
            campaignReadiness: 25, // sums to 105
          },
        }),
      ).rejects.toThrow("must sum to 100");
    });

    it("rejects weights.contentQuality rules/ai split that doesn't sum to 100", async () => {
      await expect(
        service.updateSettings({ weights: { contentQuality: { rulesPercent: 60, aiPercent: 50 } } }),
      ).rejects.toThrow("must sum to 100");
    });

    it("accepts scoreWeights that correctly sum to 100", async () => {
      settingsModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          scoreWeights: {
            profileCompletion: 20,
            contentQuality: 20,
            postingConsistency: 20,
            professionalBranding: 20,
            campaignReadiness: 20,
          },
        }),
      });

      await expect(
        service.updateSettings({
          scoreWeights: {
            profileCompletion: 20,
            contentQuality: 20,
            postingConsistency: 20,
            professionalBranding: 20,
            campaignReadiness: 20,
          },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("unknown-property passthrough", () => {
    it("stores a field not declared on the DTO/schema instead of dropping it", async () => {
      settingsModel.findOneAndUpdate.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ futureFeatureFlag: true }),
      });

      const result = await service.updateSettings({ futureFeatureFlag: true });

      const [, update] = settingsModel.findOneAndUpdate.mock.calls[0];
      expect(update.$set.futureFeatureFlag).toBe(true);
      expect((result as any).futureFeatureFlag).toBe(true);
    });
  });
});
