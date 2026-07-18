import { BadRequestException } from "@nestjs/common";
import { UsersService } from "./users.service";

describe("UsersService profile update guards", () => {
  const makeService = (overrides?: {
    influencerModel?: any;
    brandModel?: any;
    photographerModel?: any;
    campaignInviteModel?: any;
    campaignModel?: any;
    profileFlagModel?: any;
  }) => {
    const cloudinaryService = {} as any;
    const firebaseAdminService = {} as any;
    const userModel = {} as any;
    const influencerModel = overrides?.influencerModel || ({} as any);
    const brandModel = overrides?.brandModel || ({} as any);
    const photographerModel = overrides?.photographerModel || ({} as any);
    const campaignInviteModel =
      overrides?.campaignInviteModel || ({} as any);
    const campaignModel = overrides?.campaignModel || ({} as any);
    const profileFlagModel = overrides?.profileFlagModel || ({} as any);
    const plansService = {} as any;

    return new UsersService(
      cloudinaryService,
      firebaseAdminService,
      userModel,
      influencerModel,
      brandModel,
      photographerModel,
      campaignInviteModel,
      campaignModel,
      profileFlagModel,
      plansService,
    );
  };

  it("blocks influencer phone changes after team mobile verification", async () => {
    const doc: any = {
      phoneNumber: "9908763880",
      email: "old@example.com",
      isMobileVerified: true,
      set: jest.fn(),
      save: jest.fn(),
    };

    const influencerModel = {
      findById: jest.fn().mockResolvedValue(doc),
    };

    const service = makeService({ influencerModel });

    await expect(
      service.updateInfluencerProfile("inf-1", { phoneNumber: "9999999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("resets influencer email verification when email is changed", async () => {
    const doc: any = {
      phoneNumber: "9908763880",
      email: "old@example.com",
      isMobileVerified: false,
      isEmailVerified: true,
      set: jest.fn((key: string, value: any) => {
        doc[key] = value;
      }),
      save: jest.fn().mockResolvedValue({ _id: "inf-1" }),
    };

    const influencerModel = {
      findById: jest.fn().mockResolvedValue(doc),
    };

    const service = makeService({ influencerModel });

    await service.updateInfluencerProfile("inf-1", { email: "new@example.com" });
    expect(doc.set).toHaveBeenCalledWith("isEmailVerified", false);
    expect(doc.save).toHaveBeenCalled();
  });

  it("resets influencer mobile verification when phone changes and is not locked", async () => {
    const doc: any = {
      phoneNumber: "9908763880",
      email: "old@example.com",
      isMobileVerified: false,
      set: jest.fn((key: string, value: any) => {
        doc[key] = value;
      }),
      save: jest.fn().mockResolvedValue({ _id: "inf-1" }),
    };

    const influencerModel = {
      findById: jest.fn().mockResolvedValue(doc),
    };

    const service = makeService({ influencerModel });

    await service.updateInfluencerProfile("inf-1", { phoneNumber: "9999999999" });
    expect(doc.set).toHaveBeenCalledWith("isMobileVerified", false);
    expect(doc.save).toHaveBeenCalled();
  });

  it("blocks brand phone changes after team mobile verification", async () => {
    const existingBrand = {
      phoneNumber: "9908763880",
      email: "brand@example.com",
      isMobileVerified: true,
    };

    const brandModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(existingBrand),
        }),
      }),
      findByIdAndUpdate: jest.fn(),
    };

    const service = makeService({ brandModel });

    await expect(
      service.updateBrandProfile("brand-1", { phoneNumber: "9999999999" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(brandModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("resets brand email verification when email is changed", async () => {
    const existingBrand = {
      phoneNumber: "9908763880",
      email: "brand@example.com",
      isMobileVerified: false,
    };

    const brandModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(existingBrand),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };

    const service = makeService({ brandModel });

    await service.updateBrandProfile("brand-1", { email: "newbrand@example.com" });

    expect(brandModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "brand-1",
      expect.objectContaining({
        isEmailVerified: false,
      }),
      { new: true },
    );
  });

  it("resets brand mobile verification when phone changes and is not locked", async () => {
    const existingBrand = {
      phoneNumber: "9908763880",
      email: "brand@example.com",
      isMobileVerified: false,
    };

    const brandModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(existingBrand),
        }),
      }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };

    const service = makeService({ brandModel });

    await service.updateBrandProfile("brand-1", { phoneNumber: "9999999999" });

    expect(brandModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "brand-1",
      expect.objectContaining({
        phoneNumber: "9999999999",
        isMobileVerified: false,
      }),
      { new: true },
    );
  });

  it("counts only public-visible profiles in platform stats", async () => {
    const influencerModel = {
      countDocuments: jest.fn().mockResolvedValue(2),
    };
    const brandModel = {
      countDocuments: jest.fn().mockResolvedValue(3),
    };
    const photographerModel = {
      countDocuments: jest.fn().mockResolvedValue(4),
    };
    const campaignModel = {
      countDocuments: jest.fn().mockResolvedValue(5),
    };
    const profileFlagModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    const service = makeService({
      influencerModel,
      brandModel,
      photographerModel,
      campaignModel,
      profileFlagModel,
    });

    await service.getPlatformStats();

    expect(influencerModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        profileVisibility: { $nin: ["PRIVATE", "MEMBERS_ONLY"] },
      }),
    );
    expect(brandModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        profileVisibility: { $nin: ["PRIVATE", "MEMBERS_ONLY"] },
      }),
    );
    expect(photographerModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        profileVisibility: { $nin: ["PRIVATE", "MEMBERS_ONLY"] },
      }),
    );
  });

  it("requires paid unlock type for influencer contact visibility", async () => {
    const brandModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: "brand-1",
            brandUsername: "brand-one",
          }),
        }),
      }),
    };
    const campaignInviteModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "inv-1" }),
        }),
      }),
    };
    const service = makeService({ brandModel, campaignInviteModel });

    const canView = await (service as any).canViewInfluencerContact(
      { _id: "inf-1" },
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

  it("requires paid unlock type for brand contact visibility", async () => {
    const influencerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "inf-1" }),
        }),
      }),
    };
    const campaignInviteModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "inv-1" }),
        }),
      }),
    };
    const service = makeService({ influencerModel, campaignInviteModel });

    const canView = await service.canViewBrandSocialMedia(
      { _id: "brand-1", brandUsername: "brand-one" },
      "inf-1",
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
