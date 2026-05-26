import { BadRequestException } from "@nestjs/common";
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
      ],
    }).compile();

    controller = module.get<PhotographersController>(PhotographersController);
  });

  it("delegates update with authenticated user id", async () => {
    photographersService.updateProfile.mockResolvedValue({ message: "ok" });

    const req = { user: { userId: "photo-1" } };
    const body = { email: "newphoto@example.com" };

    const result = await controller.updateMyProfile(req, body);

    expect(photographersService.updateProfile).toHaveBeenCalledWith("photo-1", body);
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
