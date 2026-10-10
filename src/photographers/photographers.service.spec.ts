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
      { reconcile: jest.fn().mockResolvedValue(0) } as any,
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
      { reconcile: jest.fn().mockResolvedValue(0) } as any,
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
    const verification = {
      reconcile: jest.fn().mockResolvedValue(0),
      decide: jest.fn(),
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
      verification as any,
    );
    return { service, photographerModel, profileFlagModel, verification };
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

  it("Stage 3A-1: spoofed per-account verification never reaches the store; a handle change is reconciled", async () => {
    const { service, photographerModel, verification } = setup();
    await service.updateProfile("photo-1", {
      socialMedia: [
        {
          platform: "Instagram",
          handle: "shooter.renamed",
          tier: "Nano",
          ownershipVerification: {
            status: "verified",
            decidedHandle: "shooter.renamed",
          },
          tierVerification: { status: "verified", decidedTier: "Nano" },
          decidedById: "admin-1",
          method: "manual",
        },
      ],
    } as any);
    const [, update] = photographerModel.findByIdAndUpdate.mock.calls[0];
    const saved = update.$set.socialMedia[0];
    expect(saved.ownershipVerification).toBeUndefined();
    expect(saved.decidedById).toBeUndefined();
    expect(saved.method).toBeUndefined();
    expect(verification.decide).not.toHaveBeenCalled();
    expect(verification.reconcile).toHaveBeenCalledWith(
      "Photographer",
      "photo-1",
      [
        expect.objectContaining({
          socialAccountId: ID_A,
          handle: "shooter.renamed",
        }),
      ],
    );
  });
});

describe("PhotographersService creator save records changed sections", () => {
  it("records only what changed, after the write", async () => {
    const order: string[] = [];
    const photographerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9000000000",
            email: "p@example.com",
            isMobileVerified: true,
            location: { state: "TS" },
            socialMedia: [],
          }),
        }),
      }),
      findByIdAndUpdate: jest.fn(() => {
        order.push("write");
        return { lean: jest.fn().mockResolvedValue({ _id: "photo-1" }) };
      }),
      updateOne: jest.fn(() => {
        order.push("record");
        return Promise.resolve({});
      }),
    };
    const service = new PhotographersService(
      photographerModel as any,
      {} as any,
      { updateMany: jest.fn().mockResolvedValue({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { reconcile: jest.fn().mockResolvedValue(0) } as any,
    );
    await service.updateProfile("photo-1", {
      location: { state: "AP" },
    } as any);
    expect(order).toEqual(["write", "record"]);
    expect(photographerModel.updateOne).toHaveBeenCalledWith(
      { _id: "photo-1" },
      expect.objectContaining({
        $addToSet: { creatorUpdatedFields: { $each: ["location"] } },
      }),
    );
  });
});

describe("PhotographersService — 'your social account was updated' notices", () => {
  const make = (photographerModel: any) =>
    new PhotographersService(
      photographerModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { reconcile: jest.fn().mockResolvedValue(0) } as any,
    );

  it("the own profile returns only unanswered notices", async () => {
    const service = make({
      findById: () => ({
        lean: () =>
          Promise.resolve({
            _id: "ph1",
            lastLoginAt: new Date(),
            password: "secret",
            adminSocialNotifications: [
              { platform: "YouTube", newTier: "Micro", seen: false },
              { platform: "YouTube", newTier: "Nano", seen: true },
            ],
          }),
      }),
      db: null,
    });
    const profile: any = await service.getProfile("ph1");
    expect(profile.adminSocialNotifications).toEqual([
      { platform: "YouTube", newTier: "Micro", seen: false },
    ]);
    expect(profile.password).toBeUndefined();
  });

  it("dismiss marks them seen and records the answer", async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    await make({ updateOne }).dismissAdminSocialNotifications(
      "ph1",
      "confirmed",
    );
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "ph1" });
    expect(update.$set).toMatchObject({
      "adminSocialNotifications.$[].seen": true,
      "adminSocialNotifications.$[].userAction": "confirmed",
    });
  });
});
