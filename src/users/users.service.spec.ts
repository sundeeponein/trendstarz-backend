import { BadRequestException } from "@nestjs/common";
import { UsersService } from "./users.service";

describe("UsersService profile update guards", () => {
  const makeService = (overrides?: {
    influencerModel?: any;
    brandModel?: any;
    campaignInviteModel?: any;
  }) => {
    const cloudinaryService = {} as any;
    const userModel = {} as any;
    const influencerModel = overrides?.influencerModel || ({} as any);
    const brandModel = overrides?.brandModel || ({} as any);
    const photographerModel = {} as any;
    const campaignInviteModel =
      overrides?.campaignInviteModel || ({} as any);
    const plansService = {} as any;

    return new UsersService(
      cloudinaryService,
      userModel,
      influencerModel,
      brandModel,
      photographerModel,
      campaignInviteModel,
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
