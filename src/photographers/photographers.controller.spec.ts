import { BadRequestException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { PlansService } from "../plans/plans.service";
import { Test, TestingModule } from "@nestjs/testing";
import { PhotographersController } from "./photographers.controller";
import { PhotographersService } from "./photographers.service";

describe("PhotographersController profile update route", () => {
  let controller: PhotographersController;
  let photographersService: {
    updateProfile: jest.Mock;
  };

  beforeEach(async () => {
    photographersService = {
      updateProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PhotographersController],
      providers: [
        { provide: PhotographersService, useValue: photographersService },
        // Also required by the controller's constructor and its DailyUsageGuard.
        { provide: PlansService, useValue: { getUserPlanCapabilities: jest.fn().mockResolvedValue({ limits: [], features: [] }) } },
        {
          provide: getModelToken("UsageCounter"),
          useValue: { findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }), findOneAndUpdate: jest.fn().mockResolvedValue(null) },
        },

      ],
    }).compile();

    controller = module.get<PhotographersController>(PhotographersController);
  });

  it("delegates update with authenticated user id", async () => {
    photographersService.updateProfile.mockResolvedValue({ message: "ok" });

    const req = { user: { userId: "photo-1" } };
    const body = { email: "newphoto@example.com" };

    const result = await controller.updateMyProfile(req, body);

    expect(photographersService.updateProfile).toHaveBeenCalledWith("photo-1", body, false) // localAuthBypass off for normal requests;
    expect(result).toEqual({ message: "ok" });
  });

  it("propagates mobile-lock bad request from service", async () => {
    photographersService.updateProfile.mockRejectedValue(
      new BadRequestException(
        "Mobile number is verified by TrendStarz Team. Contact support to change it.",
      ),
    );

    const req = { user: { userId: "photo-1" } };

    await expect(
      controller.updateMyProfile(req, { phoneNumber: "9999999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
