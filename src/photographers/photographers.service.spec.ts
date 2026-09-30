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

describe("PhotographersService social accounts on creator save (Stage 3A-0)", () => {
  const ID_A = "64b0000000000000000000a1";
  const stored = {
    socialAccountId: ID_A,
    platformKey: "instagram",
    platform: "Instagram",
    handle: "shooter",
    tier: "Nano",
    followersCount: 0,
    contentTypes: [],
    tierVerification: { status: "verified", decidedTier: "Nano" },
  };
  const setup = () => {
    const photographerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9000000000",
            email: "p@example.com",
            socialMedia: [stored],
          }),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "photo-1" }),
      }),
    };
    const profileFlagModel = {
      updateMany: jest.fn().mockResolvedValue({}),
      countDocuments: jest.fn().mockResolvedValue(2),
    };
    const service = new PhotographersService(
      photographerModel as any,
      {} as any,
      profileFlagModel as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, photographerModel, profileFlagModel };
  };

  it("preserves identity and server fields, never sets creatorTierVerified, and only notes admin flags", async () => {
    const { service, photographerModel, profileFlagModel } = setup();

    // Hidden tier Nano kept; the creator changes the handle and tries to spoof verification.
    await service.updateProfile("photo-1", {
      socialMedia: [
        {
          platform: "Instagram",
          handle: "shooter.new",
          tier: "Nano",
          followersCount: 0,
          tierVerification: { status: "rejected" },
        },
      ],
    });

    expect(photographerModel.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = photographerModel.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.creatorTierVerified).toBeUndefined();
    expect(update.$set.socialMedia[0]).toMatchObject({
      socialAccountId: ID_A,
      handle: "shooter.new",
      tier: "Nano",
      tierVerification: { status: "verified", decidedTier: "Nano" },
    });
    const [filter, flagUpdate] = profileFlagModel.updateMany.mock.calls[0];
    expect(filter).toMatchObject({
      userType: "Photographer",
      status: "Open",
      createdBy: "ADMIN",
    });
    expect(flagUpdate.$set).toBeUndefined();
    expect(flagUpdate.$push.auditLog.note).toContain("Instagram handle");
  });

  it("a creator save cannot set creatorTierVerified", async () => {
    const { service, photographerModel } = setup();
    await service.updateProfile("photo-1", {
      creatorTierVerified: true,
      name: "Shooter",
    } as any);
    const [, update] = photographerModel.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.creatorTierVerified).toBeUndefined();
  });
});
