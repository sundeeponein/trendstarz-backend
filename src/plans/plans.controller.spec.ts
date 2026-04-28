import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { ImageCleanupService } from "./image-cleanup.service";

describe("PlansController", () => {
  let controller: PlansController;
  let imageCleanupService: {
    previewCleanupEligibility: jest.Mock;
  };

  beforeEach(async () => {
    const mockPlansService = {
      listAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      listActive: jest.fn(),
      getActiveSubscription: jest.fn(),
      getUserPlanCapabilities: jest.fn(),
      getUserSubscriptions: jest.fn(),
    };

    imageCleanupService = {
      previewCleanupEligibility: jest.fn().mockResolvedValue({ success: true, dryRun: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [
        { provide: PlansService, useValue: mockPlansService },
        { provide: ImageCleanupService, useValue: imageCleanupService },
      ],
    }).compile();

    controller = module.get<PlansController>(PlansController);
  });

  describe("cleanupPreview", () => {
    it("throws when no query params are provided", async () => {
      await expect(controller.cleanupPreview(undefined, undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(imageCleanupService.previewCleanupEligibility).not.toHaveBeenCalled();
    });

    it("delegates preview by userId", async () => {
      const result = await controller.cleanupPreview("user-1", undefined);
      expect(imageCleanupService.previewCleanupEligibility).toHaveBeenCalledWith({
        userId: "user-1",
        subscriptionId: undefined,
      });
      expect(result).toEqual({ success: true, dryRun: true });
    });

    it("delegates preview by subscriptionId", async () => {
      const result = await controller.cleanupPreview(undefined, "sub-1");
      expect(imageCleanupService.previewCleanupEligibility).toHaveBeenCalledWith({
        userId: undefined,
        subscriptionId: "sub-1",
      });
      expect(result).toEqual({ success: true, dryRun: true });
    });
  });
});
