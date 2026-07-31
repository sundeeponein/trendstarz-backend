import { PhotographersService } from "./photographers.service";

describe("PhotographersService profile update guards", () => {
  const makeService = (photographerModel: any) =>
    new PhotographersService(
      photographerModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it("resets mobile verification when verified phone is changed", async () => {
    const photographerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9908763880",
            email: "photo@example.com",
            isMobileVerified: true,
          }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "photo-1" }),
      }),
    };

    const service = makeService(photographerModel);

    await service.updateProfile("photo-1", { phoneNumber: "9999999999" });

    expect(photographerModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "photo-1",
      {
        $set: expect.objectContaining({
          phoneNumber: "9999999999",
          isMobileVerified: false,
          previousVerifiedMobile: "9908763880",
        }),
      },
      { new: true },
    );
  });

  it("resets email verification when email changes", async () => {
    const photographerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9908763880",
            email: "photo@example.com",
            isMobileVerified: false,
          }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "photo-1" }),
      }),
    };

    const service = makeService(photographerModel);

    await service.updateProfile("photo-1", { email: "newphoto@example.com" });

    expect(photographerModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "photo-1",
      {
        $set: expect.objectContaining({
          email: "newphoto@example.com",
          isEmailVerified: false,
        }),
      },
      { new: true },
    );
  });

  it("resets mobile verification when phone changes and is not locked", async () => {
    const photographerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9908763880",
            email: "photo@example.com",
            isMobileVerified: false,
          }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "photo-1" }),
      }),
    };

    const service = makeService(photographerModel);

    await service.updateProfile("photo-1", { phoneNumber: "9999999999" });

    expect(photographerModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "photo-1",
      {
        $set: expect.objectContaining({
          phoneNumber: "9999999999",
          isMobileVerified: false,
        }),
      },
      { new: true },
    );
  });

  it("requires paid unlock type for photographer contact visibility", async () => {
    const campaignInviteModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "inv-1" }),
        }),
      }),
    };

    const service = new PhotographersService(
      {} as any,
      campaignInviteModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const canView = await (service as any).canViewPhotographerContact(
      { _id: "photo-1" },
      "brand-1",
    );

    expect(canView).toBe(true);
    expect(campaignInviteModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        unlocked: true,
        unlockType: "paid_collab_payment",
      }),
    );
  });
});
