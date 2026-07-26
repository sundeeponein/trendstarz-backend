import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";
import defaultSettingsJson from "./collaboration-score-settings.default.json";

describe("CollaborationScoreSettingsService", () => {
  let service: CollaborationScoreSettingsService;
  let settingsModel: any;

  beforeEach(() => {
    settingsModel = {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    };
    service = new CollaborationScoreSettingsService(settingsModel);
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
});
