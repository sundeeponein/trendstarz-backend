import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

describe("UsersController profile update routes", () => {
  let controller: UsersController;
  let usersService: {
    updateInfluencerProfile: jest.Mock;
    updateBrandProfile: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      updateInfluencerProfile: jest.fn(),
      updateBrandProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it("delegates influencer profile update with authenticated user id", async () => {
    usersService.updateInfluencerProfile.mockResolvedValue({ message: "ok" });

    const req = { user: { userId: "inf-1" } };
    const body = { phoneNumber: "9999999999" };

    const result = await controller.updateInfluencerProfile(req, body);

    expect(usersService.updateInfluencerProfile).toHaveBeenCalledWith("inf-1", body);
    expect(result).toEqual({ message: "ok" });
  });

  it("propagates influencer mobile-lock bad request from service", async () => {
    usersService.updateInfluencerProfile.mockRejectedValue(
      new BadRequestException(
        "Mobile number is verified by TrendStarz Team. Contact support to change it.",
      ),
    );

    const req = { user: { userId: "inf-1" } };

    await expect(
      controller.updateInfluencerProfile(req, { phoneNumber: "9999999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("delegates brand profile update with authenticated user id", async () => {
    usersService.updateBrandProfile.mockResolvedValue({ message: "ok" });

    const req = { user: { userId: "brand-1" } };
    const body = { email: "newbrand@example.com" };

    const result = await controller.updateBrandProfile(req, body);

    expect(usersService.updateBrandProfile).toHaveBeenCalledWith("brand-1", body);
    expect(result).toEqual({ message: "ok" });
  });

  it("propagates brand mobile-lock bad request from service", async () => {
    usersService.updateBrandProfile.mockRejectedValue(
      new BadRequestException(
        "Mobile number is verified by TrendStarz Team. Contact support to change it.",
      ),
    );

    const req = { user: { userId: "brand-1" } };

    await expect(
      controller.updateBrandProfile(req, { phoneNumber: "9999999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
