import { UsersService } from "./users.service";

describe("UsersService profile update guards", () => {
  const makeService = (overrides?: {
    influencerModel?: any;
    brandModel?: any;
    photographerModel?: any;
    campaignInviteModel?: any;
    campaignModel?: any;
    profileFlagModel?: any;
    collaborationAuditModel?: any;
    paymentModel?: any;
    transactionModel?: any;
    socialOAuthConnectionModel?: any;
    cloudinaryService?: any;
    firebaseAdminService?: any;
    metaOAuthService?: any;
    reviewModel?: any;
    campaignTransactionModel?: any;
    socialAccountVerification?: any;
  }) => {
    const cloudinaryService = overrides?.cloudinaryService || ({} as any);
    const firebaseAdminService = overrides?.firebaseAdminService || ({} as any);
    const userModel = {} as any;
    const influencerModel = overrides?.influencerModel || ({} as any);
    const brandModel = overrides?.brandModel || ({} as any);
    const photographerModel = overrides?.photographerModel || ({} as any);
    const campaignInviteModel =
      overrides?.campaignInviteModel || ({} as any);
    const campaignModel = overrides?.campaignModel || ({} as any);
    const profileFlagModel = overrides?.profileFlagModel || ({} as any);
    const collaborationAuditModel = overrides?.collaborationAuditModel || ({} as any);
    const paymentModel = overrides?.paymentModel || ({} as any);
    const transactionModel = overrides?.transactionModel || ({} as any);
    const socialOAuthConnectionModel = overrides?.socialOAuthConnectionModel || ({} as any);
    const plansService = {
      canViewSocialLinks: jest.fn().mockResolvedValue(true),
      listActive: jest.fn().mockResolvedValue({ plans: [] }),
    } as any;
    const metaOAuthService = overrides?.metaOAuthService || ({ revokePermissions: jest.fn().mockResolvedValue(undefined) } as any);

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
      collaborationAuditModel,
      paymentModel,
      transactionModel,
      socialOAuthConnectionModel,
      plansService,
      metaOAuthService,
      overrides?.reviewModel || ({} as any),
      overrides?.campaignTransactionModel || ({} as any),
      overrides?.socialAccountVerification ||
        ({ reconcile: jest.fn().mockResolvedValue(0) } as any),
    );
  };

  it("resets influencer mobile verification when verified phone is changed", async () => {
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

    await service.updateInfluencerProfile("inf-1", { phoneNumber: "9999999999" });
    expect(doc.set).toHaveBeenCalledWith("previousVerifiedMobile", "9908763880");
    expect(doc.set).toHaveBeenCalledWith("isMobileVerified", false);
    expect(doc.save).toHaveBeenCalled();
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

  it("resets brand mobile verification when verified phone is changed", async () => {
    const existingBrand = {
      phoneNumber: "9908763880",
      email: "brand@example.com",
      isMobileVerified: true,
    };

    const brandModel = {
      findById: jest.fn().mockImplementation(() => ({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(existingBrand),
        }),
      })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };

    const service = makeService({ brandModel });

    await service.updateBrandProfile("brand-1", { phoneNumber: "9999999999" });
    expect(brandModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "brand-1",
      expect.objectContaining({
        phoneNumber: "9999999999",
        isMobileVerified: false,
        previousVerifiedMobile: "9908763880",
      }),
      { new: true },
    );
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

  it("serves platform stats from cache on repeat calls", async () => {
    const influencerModel = {
      countDocuments: jest.fn().mockResolvedValue(2),
      distinct: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue([]),
    };
    const flatModel = { countDocuments: jest.fn().mockResolvedValue(1), distinct: jest.fn().mockResolvedValue([]) };
    const service = makeService({
      influencerModel,
      brandModel: flatModel,
      photographerModel: { ...flatModel },
      campaignModel: { countDocuments: jest.fn().mockResolvedValue(0) },
      profileFlagModel: { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) },
      reviewModel: { aggregate: jest.fn().mockResolvedValue([]) },
      campaignTransactionModel: { aggregate: jest.fn().mockResolvedValue([]) },
    });

    const first = await service.getPlatformStats();
    const second = await service.getPlatformStats();

    expect(second).toBe(first);
    expect(influencerModel.aggregate).toHaveBeenCalledTimes(1);
  });

  it("counts only public-visible profiles in platform stats", async () => {
    const influencerModel = {
      countDocuments: jest.fn().mockResolvedValue(2),
      distinct: jest.fn().mockResolvedValue(["Hyderabad", "Pune"]),
      aggregate: jest.fn().mockResolvedValue([
        { _id: "Fashion", count: 2 },
        { _id: " ", count: 1 },
      ]),
    };
    const brandModel = {
      countDocuments: jest.fn().mockResolvedValue(3),
      distinct: jest.fn().mockResolvedValue([" hyderabad "]),
    };
    const photographerModel = {
      countDocuments: jest.fn().mockResolvedValue(4),
      distinct: jest.fn().mockResolvedValue([null, ""]),
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
      reviewModel: {
        aggregate: jest.fn().mockResolvedValue([{ avg: 4.86, count: 12 }]),
      },
      campaignTransactionModel: {
        aggregate: jest.fn().mockResolvedValue([{ total: 250000 }]),
      },
    });

    const stats = await service.getPlatformStats();

    expect(stats).toEqual(
      expect.objectContaining({
        averageRating: 4.9,
        ratingCount: 12,
        creatorEscrowTotal: 250000,
        totalCities: 2,
        influencerCategoryCounts: { Fashion: 2 },
      }),
    );

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

  it("uses plan capability for brand social visibility", async () => {
    const influencerModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "inf-1" }),
        }),
      }),
    };
    const service = makeService({ influencerModel });

    const canView = await service.canViewBrandSocialMedia(
      { _id: "brand-1", brandUsername: "brand-one" },
      "inf-1",
    );

    expect(canView).toBe(true);
  });

  it("keeps local creators ahead of out-of-state premium creators", () => {
    const service = makeService();
    const viewer = { district: "Pune", state: "Maharashtra", country: "India" };

    const localFree = {
      location: { district: "Pune", state: "Maharashtra", country: "India" },
      isPremium: false,
      profileCompletion: 60,
      socialMedia: [{ followersCount: 1000 }],
      updatedAt: new Date("2026-01-01"),
    };
    const remotePremium = {
      location: { district: "Bengaluru", state: "Karnataka", country: "India" },
      isPremium: true,
      premiumEnd: new Date("2099-01-01"),
      profileCompletion: 90,
      socialMedia: [{ followersCount: 5000 }],
      updatedAt: new Date("2026-06-01"),
    };

    const result = (service as any).compareSearchRank(localFree, remotePremium, viewer);
    expect(result).toBeLessThan(0);
  });

  it("applies premium boost within the same location tier", () => {
    const service = makeService();
    const viewer = { district: "Pune", state: "Maharashtra", country: "India" };

    const localPremium = {
      location: { district: "Pune", state: "Maharashtra", country: "India" },
      isPremium: true,
      premiumEnd: new Date("2099-01-01"),
      profileCompletion: 50,
      socialMedia: [{ followersCount: 500 }],
      updatedAt: new Date("2026-01-01"),
    };
    const localFree = {
      location: { district: "Pune", state: "Maharashtra", country: "India" },
      isPremium: false,
      profileCompletion: 95,
      socialMedia: [{ followersCount: 5000 }],
      updatedAt: new Date("2026-06-01"),
    };

    const result = (service as any).compareSearchRank(localPremium, localFree, viewer);
    expect(result).toBeLessThan(0);
  });

  describe("deletePermanently — Collaboration Score cascade cleanup", () => {
    const fakeInfluencer = { _id: "507f1f77bcf86cd799439011", profileImages: [], verificationDocuments: [] };

    it("hard-deletes CollaborationAudit docs and archives (not deletes) reanalysis payments/transactions", async () => {
      const influencerModel = {
        findById: jest
          .fn()
          .mockResolvedValueOnce(fakeInfluencer) // initial lookup
          .mockResolvedValueOnce(null), // post-delete double-check
        findByIdAndDelete: jest.fn().mockResolvedValue(fakeInfluencer),
      };
      const collaborationAuditModel = { deleteMany: jest.fn().mockResolvedValue({}) };
      const paymentModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const transactionModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const firebaseAdminService = { isConfigured: jest.fn().mockReturnValue(false) };

      const service = makeService({
        influencerModel,
        collaborationAuditModel,
        paymentModel,
        transactionModel,
        firebaseAdminService,
      });

      await service.deletePermanently("507f1f77bcf86cd799439011");

      expect(collaborationAuditModel.deleteMany).toHaveBeenCalledWith({ userId: "507f1f77bcf86cd799439011" });
      expect(paymentModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "collab_score_reanalysis" }),
        expect.objectContaining({
          $set: expect.objectContaining({
            archivedAt: expect.any(Date),
            "userSnapshot.name": null,
            "userSnapshot.email": null,
          }),
        }),
      );
      expect(transactionModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "collab_score_reanalysis" }),
        expect.objectContaining({ $set: expect.objectContaining({ archivedAt: expect.any(Date) }) }),
      );
    });

    it("does not throw or block deletion when the cascade cleanup itself fails", async () => {
      const influencerModel = {
        findById: jest.fn().mockResolvedValueOnce(fakeInfluencer).mockResolvedValueOnce(null),
        findByIdAndDelete: jest.fn().mockResolvedValue(fakeInfluencer),
      };
      const collaborationAuditModel = {
        deleteMany: jest.fn().mockRejectedValue(new Error("Mongo unavailable")),
      };
      const paymentModel = { updateMany: jest.fn().mockRejectedValue(new Error("Mongo unavailable")) };
      const transactionModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const firebaseAdminService = { isConfigured: jest.fn().mockReturnValue(false) };

      const service = makeService({
        influencerModel,
        collaborationAuditModel,
        paymentModel,
        transactionModel,
        firebaseAdminService,
      });

      await expect(service.deletePermanently("507f1f77bcf86cd799439011")).resolves.toMatchObject({
        message: "Influencer permanently deleted",
      });
    });

    it("best-effort revokes and hard-deletes SocialOAuthConnection docs (not archived)", async () => {
      const influencerModel = {
        findById: jest.fn().mockResolvedValueOnce(fakeInfluencer).mockResolvedValueOnce(null),
        findByIdAndDelete: jest.fn().mockResolvedValue(fakeInfluencer),
      };
      const collaborationAuditModel = { deleteMany: jest.fn().mockResolvedValue({}) };
      const paymentModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const transactionModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const firebaseAdminService = { isConfigured: jest.fn().mockReturnValue(false) };
      const socialOAuthConnectionModel = {
        find: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              { _id: "conn-1", platform: "instagram", instagramBusinessAccountId: "ig-1", accessToken: "token-a" },
              { _id: "conn-2", platform: "facebook", facebookPageId: "page-1", accessToken: "token-b" },
            ]),
          }),
        }),
        deleteMany: jest.fn().mockResolvedValue({}),
      };
      const metaOAuthService = { revokePermissions: jest.fn().mockResolvedValue(undefined) };

      const service = makeService({
        influencerModel,
        collaborationAuditModel,
        paymentModel,
        transactionModel,
        firebaseAdminService,
        socialOAuthConnectionModel,
        metaOAuthService,
      });

      await service.deletePermanently("507f1f77bcf86cd799439011");

      expect(metaOAuthService.revokePermissions).toHaveBeenCalledWith("ig-1", "token-a");
      expect(metaOAuthService.revokePermissions).toHaveBeenCalledWith("page-1", "token-b");
      expect(socialOAuthConnectionModel.deleteMany).toHaveBeenCalledWith({ userId: "507f1f77bcf86cd799439011" });
    });

    it("still deletes SocialOAuthConnection docs even if the Meta revoke call fails", async () => {
      const influencerModel = {
        findById: jest.fn().mockResolvedValueOnce(fakeInfluencer).mockResolvedValueOnce(null),
        findByIdAndDelete: jest.fn().mockResolvedValue(fakeInfluencer),
      };
      const collaborationAuditModel = { deleteMany: jest.fn().mockResolvedValue({}) };
      const paymentModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const transactionModel = { updateMany: jest.fn().mockResolvedValue({}) };
      const firebaseAdminService = { isConfigured: jest.fn().mockReturnValue(false) };
      const socialOAuthConnectionModel = {
        find: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest
              .fn()
              .mockResolvedValue([
                { _id: "conn-1", platform: "instagram", instagramBusinessAccountId: "ig-1", accessToken: "token-a" },
              ]),
          }),
        }),
        deleteMany: jest.fn().mockResolvedValue({}),
      };
      const metaOAuthService = { revokePermissions: jest.fn().mockRejectedValue(new Error("Meta API down")) };

      const service = makeService({
        influencerModel,
        collaborationAuditModel,
        paymentModel,
        transactionModel,
        firebaseAdminService,
        socialOAuthConnectionModel,
        metaOAuthService,
      });

      await expect(service.deletePermanently("507f1f77bcf86cd799439011")).resolves.toMatchObject({
        message: "Influencer permanently deleted",
      });
      // A failed remote revoke must not strand the connection doc (and its
      // access token) in the database — deleteMany still runs.
      expect(socialOAuthConnectionModel.deleteMany).toHaveBeenCalledWith({ userId: "507f1f77bcf86cd799439011" });
    });
  });
});

// ── Stage 3A-0: creator saves vs server-owned social data ───────────────────
describe("UsersService social accounts on creator save (Stage 3A-0)", () => {
  const ID_A = "64b0000000000000000000a1";
  const make = (models: {
    influencerModel?: any;
    brandModel?: any;
    profileFlagModel?: any;
    socialAccountVerification?: any;
  }) =>
    new UsersService(
      {} as any, // cloudinaryService
      {} as any, // firebaseAdminService
      {} as any, // userModel
      models.influencerModel || ({} as any),
      models.brandModel || ({} as any),
      {} as any, // photographerModel
      {} as any, // campaignInviteModel
      {} as any, // campaignModel
      models.profileFlagModel ||
        ({ updateMany: jest.fn().mockResolvedValue({}) } as any),
      {} as any, // collaborationAuditModel
      {} as any, // paymentModel
      {} as any, // transactionModel
      {} as any, // socialOAuthConnectionModel
      {
        canViewSocialLinks: jest.fn().mockResolvedValue(true),
        listActive: jest.fn().mockResolvedValue({ plans: [] }),
      } as any,
      { revokePermissions: jest.fn() } as any,
      {} as any, // reviewModel
      {} as any, // campaignTransactionModel
      models.socialAccountVerification ||
        ({ reconcile: jest.fn().mockResolvedValue(0) } as any),
    );

  const storedEntry = () => ({
    socialAccountId: ID_A,
    platformKey: "instagram",
    platform: "Instagram",
    handle: "creator.one",
    tier: "Micro",
    followersCount: 0,
    contentTypes: [],
    // Server-owned data a later phase adds — must survive any creator save.
    ownershipVerification: {
      status: "verified",
      method: "manual",
      decidedHandle: "creator.one",
    },
    observedFollowers: { count: 8200, source: "admin_manual" },
  });

  const influencerDoc = (entries: any[]) => {
    const doc: any = {
      phoneNumber: "9000000000",
      email: "c@example.com",
      socialMedia: entries,
      creatorTierVerified: false,
      set: jest.fn((k: string, v: any) => {
        doc[k] = v;
      }),
      save: jest.fn(() => Promise.resolve(doc)),
    };
    return doc;
  };

  const browserPayload = (over: any = {}) => ({
    socialMedia: [
      {
        platform: "Instagram",
        handle: "creator.one",
        tier: "Micro",
        followersCount: 0,
        contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
        ownershipVerification: { status: "verified" },
        socialAccountId: "64b0000000000000000000ff",
        ...over,
      },
    ],
  });

  it("keeps the account id and server-owned data, and ignores spoofed fields", async () => {
    const doc = influencerDoc([storedEntry()]);
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
    });

    await service.updateInfluencerProfile("inf-1", browserPayload());

    const [saved] = doc.set.mock.calls.find(
      ([k]: any[]) => k === "socialMedia",
    )[1];
    expect(saved).toMatchObject({
      socialAccountId: ID_A,
      platformKey: "instagram",
      followersCount: 0,
      ownershipVerification: {
        status: "verified",
        method: "manual",
        decidedHandle: "creator.one",
      },
      observedFollowers: { count: 8200, source: "admin_manual" },
      contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
    });
    expect(doc.save).toHaveBeenCalled();
  });

  it("an unverified account cannot verify itself through a save", async () => {
    const unverified: any = storedEntry();
    delete unverified.ownershipVerification;
    delete unverified.observedFollowers;
    const doc = influencerDoc([unverified]);
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
    });

    await service.updateInfluencerProfile(
      "inf-1",
      browserPayload({ observedFollowers: { count: 1 } }),
    );

    const [saved] = doc.set.mock.calls.find(
      ([k]: any[]) => k === "socialMedia",
    )[1];
    expect(saved.ownershipVerification).toBeUndefined();
    expect(saved.observedFollowers).toBeUndefined();
  });

  it("never auto-verifies: re-saving after an admin flag leaves creatorTierVerified and the flag alone", async () => {
    const doc = influencerDoc([storedEntry()]);
    const influencerModel = {
      findById: jest.fn().mockResolvedValue(doc),
      findByIdAndUpdate: jest.fn(),
    };
    const profileFlagModel = {
      updateMany: jest.fn().mockResolvedValue({}),
      countDocuments: jest.fn().mockResolvedValue(3),
    };
    const service = make({ influencerModel, profileFlagModel });

    await service.updateInfluencerProfile(
      "inf-1",
      browserPayload({ tier: "Mid-Tier" }),
    );

    expect(influencerModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(doc.creatorTierVerified).toBe(false);
    // Only an audit note on ADMIN-opened flags — never a status change.
    expect(profileFlagModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = profileFlagModel.updateMany.mock.calls[0];
    expect(filter).toMatchObject({
      userId: "inf-1",
      userType: "Influencer",
      status: "Open",
      createdBy: "ADMIN",
    });
    expect(update.$set).toBeUndefined();
    expect(update.$push.auditLog).toMatchObject({
      action: "creator_updated",
      actorRole: "user",
    });
    expect(update.$push.auditLog.note).toContain("Instagram tier");
  });

  it("adds no note when nothing identity-related changed, and still saves normal fields", async () => {
    const doc = influencerDoc([storedEntry()]);
    const profileFlagModel = { updateMany: jest.fn().mockResolvedValue({}) };
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
      profileFlagModel,
    });

    await service.updateInfluencerProfile("inf-1", {
      ...browserPayload(),
      gender: "female",
    });

    expect(profileFlagModel.updateMany).not.toHaveBeenCalled();
    expect(doc.set).toHaveBeenCalledWith("gender", "female");
    expect(doc.save).toHaveBeenCalled();
  });

  it("merges brand socials against the stored ones", async () => {
    const brandModel = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9000000000",
            email: "b@example.com",
            socialMedia: [{ ...storedEntry(), tier: "Nano" }],
          }),
        })),
      })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };
    const service = make({ brandModel });

    await service.updateBrandProfile(
      "brand-1",
      browserPayload({ tier: "Nano", followersCount: 55 }),
    );

    const [, update] = brandModel.findByIdAndUpdate.mock.calls[0];
    const saved = (update.$set || update).socialMedia[0];
    expect(saved).toMatchObject({
      socialAccountId: ID_A,
      tier: "Nano",
      followersCount: 0,
    });
    expect(saved.ownershipVerification).toMatchObject({ status: "verified" });
  });

  it("a creator save cannot set creatorTierVerified (influencer and brand)", async () => {
    const doc = influencerDoc([storedEntry()]);
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
    });
    await service.updateInfluencerProfile("inf-1", {
      ...browserPayload(),
      creatorTierVerified: true,
    } as any);
    expect(
      doc.set.mock.calls.some(([k]: any[]) => k === "creatorTierVerified"),
    ).toBe(false);
    expect(doc.creatorTierVerified).toBe(false);

    const brandModel = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9000000000",
            email: "b@example.com",
            socialMedia: [],
          }),
        })),
      })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };
    await make({ brandModel }).updateBrandProfile("brand-1", {
      creatorTierVerified: true,
      description: "x",
    } as any);
    const [, update] = brandModel.findByIdAndUpdate.mock.calls[0];
    expect("creatorTierVerified" in (update.$set || update)).toBe(false);
  });
});

// ── Stage 3A-1: creator saves vs per-account verification ───────────────────
describe("UsersService creator saves vs per-account verification (Stage 3A-1)", () => {
  const ID_A = "64b0000000000000000000a1";
  const verificationService = () => ({
    reconcile: jest.fn().mockResolvedValue(0),
    decide: jest.fn(),
    listForProfile: jest.fn(),
  });
  const make = (models: {
    influencerModel?: any;
    brandModel?: any;
    socialAccountVerification: any;
  }) =>
    new UsersService(
      {} as any, // cloudinaryService
      {} as any, // firebaseAdminService
      {} as any, // userModel
      models.influencerModel || ({} as any),
      models.brandModel || ({} as any),
      {} as any, // photographerModel
      {} as any, // campaignInviteModel
      {} as any, // campaignModel
      { updateMany: jest.fn().mockResolvedValue({}) } as any, // profileFlagModel
      {} as any, // collaborationAuditModel
      {} as any, // paymentModel
      {} as any, // transactionModel
      {} as any, // socialOAuthConnectionModel
      {
        canViewSocialLinks: jest.fn().mockResolvedValue(true),
        listActive: jest.fn().mockResolvedValue({ plans: [] }),
      } as any,
      { revokePermissions: jest.fn() } as any,
      {} as any, // reviewModel
      {} as any, // campaignTransactionModel
      models.socialAccountVerification,
    );

  const stored = () => ({
    socialAccountId: ID_A,
    platformKey: "instagram",
    platform: "Instagram",
    handle: "creator.one",
    tier: "Micro",
    followersCount: 0,
    contentTypes: [],
  });

  // Everything a creator might try to smuggle in to look verified.
  const spoofed = {
    ownershipVerification: {
      status: "verified",
      method: "manual",
      decidedHandle: "creator.new",
      decidedAt: "2026-01-01T00:00:00.000Z",
      decidedById: "admin-1",
      decidedByName: "Asha",
    },
    tierVerification: { status: "verified", decidedTier: "Mid-Tier" },
    status: "verified",
    method: "manual",
    decidedHandle: "creator.new",
    decidedTier: "Mid-Tier",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decidedById: "admin-1",
    decidedByName: "Asha",
    socialAccountId: "64b0000000000000000000ff",
    platformKey: "youtube",
    followersCount: 999999,
  };

  const influencerDoc = () => {
    const doc: any = {
      phoneNumber: "9000000000",
      email: "c@example.com",
      socialMedia: [stored()],
      creatorTierVerified: true, // legacy value — must stay exactly as is
      set: jest.fn((k: string, v: any) => {
        doc[k] = v;
      }),
      save: jest.fn(() => Promise.resolve(doc)),
    };
    return doc;
  };

  it("influencer: spoofed verification fields never persist, the store is never written, and reconcile gets the server entry", async () => {
    const doc = influencerDoc();
    const svc = verificationService();
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
      socialAccountVerification: svc,
    });

    await service.updateInfluencerProfile("inf-1", {
      ...spoofed,
      creatorTierVerified: false,
      socialMedia: [
        {
          platform: "Instagram",
          handle: "creator.new",
          tier: "Mid-Tier",
          contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
          ...spoofed,
        },
      ],
    } as any);

    const [saved] = doc.set.mock.calls.find(
      ([k]: any[]) => k === "socialMedia",
    )[1];
    for (const key of [
      "ownershipVerification",
      "tierVerification",
      "status",
      "method",
      "decidedHandle",
      "decidedTier",
      "decidedAt",
      "decidedById",
      "decidedByName",
    ]) {
      expect(saved[key]).toBeUndefined();
    }
    expect(saved).toMatchObject({
      socialAccountId: ID_A,
      platformKey: "instagram",
      followersCount: 0,
      handle: "creator.new",
      tier: "Mid-Tier",
    });
    for (const key of Object.keys(spoofed)) {
      expect(doc.set.mock.calls.some(([k]: any[]) => k === key)).toBe(false);
    }
    // Legacy profile-level field untouched (neither cleared nor set).
    expect(doc.creatorTierVerified).toBe(true);
    expect(
      doc.set.mock.calls.some(([k]: any[]) => k === "creatorTierVerified"),
    ).toBe(false);

    // A creator save can only ever invalidate — never decide.
    expect(svc.decide).not.toHaveBeenCalled();
    expect(svc.reconcile).toHaveBeenCalledTimes(1);
    const [type, id, list] = svc.reconcile.mock.calls[0];
    expect([type, id]).toEqual(["Influencer", "inf-1"]);
    expect(list[0]).toMatchObject({
      socialAccountId: ID_A,
      handle: "creator.new",
      tier: "Mid-Tier",
    });
  });

  it("influencer: no reconcile when socialMedia isn't part of the save", async () => {
    const doc = influencerDoc();
    const svc = verificationService();
    const service = make({
      influencerModel: { findById: jest.fn().mockResolvedValue(doc) },
      socialAccountVerification: svc,
    });
    await service.updateInfluencerProfile("inf-1", { gender: "female" });
    expect(svc.reconcile).not.toHaveBeenCalled();
  });

  it("brand: reconcile runs with the merged list after the save", async () => {
    const svc = verificationService();
    const brandModel = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue({
            phoneNumber: "9000000000",
            email: "b@example.com",
            socialMedia: [stored()],
          }),
        })),
      })),
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "brand-1" }),
    };
    await make({
      brandModel,
      socialAccountVerification: svc,
    }).updateBrandProfile("brand-1", {
      socialMedia: [
        {
          platform: "Instagram",
          handle: "brand.new",
          tier: "Micro",
          ...spoofed,
        },
      ],
    } as any);
    const [, update] = brandModel.findByIdAndUpdate.mock.calls[0];
    const saved = (update.$set || update).socialMedia[0];
    expect(saved.ownershipVerification).toBeUndefined();
    expect(saved.tierVerification).toBeUndefined();
    expect(svc.decide).not.toHaveBeenCalled();
    expect(svc.reconcile).toHaveBeenCalledWith(
      "Brand",
      "brand-1",
      expect.arrayContaining([
        expect.objectContaining({ socialAccountId: ID_A, handle: "brand.new" }),
      ]),
    );
  });
});

// ── Stage 3A-2: creator saves cannot inject platform observations ───────────
describe("UsersService creator saves vs platform observation (Stage 3A-2)", () => {
  const ID_A = "64b0000000000000000000a1";
  const injected = {
    observedFollowersCount: 999999,
    externalAccountId: "fake",
    observationStatus: "success",
    observation: { status: "success", observedFollowersCount: 999999 },
    observedHandle: "someone.else",
    source: "youtube",
    capturedAt: "2020-01-01T00:00:00.000Z",
    externalUrl: "https://youtube.com/@fake",
    lastError: null,
  };

  it("observation fields in a creator save are dropped, and followersCount stays server-owned", async () => {
    const doc: any = {
      phoneNumber: "9000000000",
      email: "c@example.com",
      socialMedia: [
        {
          socialAccountId: ID_A,
          platformKey: "youtube",
          platform: "YouTube",
          handle: "creator123",
          tier: "Micro",
          followersCount: 0,
          contentTypes: [],
        },
      ],
      set: jest.fn((k: string, v: any) => {
        doc[k] = v;
      }),
      save: jest.fn(() => Promise.resolve(doc)),
    };
    const service = new UsersService(
      {} as any,
      {} as any,
      {} as any,
      { findById: jest.fn().mockResolvedValue(doc) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { updateMany: jest.fn().mockResolvedValue({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        canViewSocialLinks: jest.fn().mockResolvedValue(true),
        listActive: jest.fn().mockResolvedValue({ plans: [] }),
      } as any,
      { revokePermissions: jest.fn() } as any,
      {} as any,
      {} as any,
      { reconcile: jest.fn().mockResolvedValue(0) } as any,
    );

    await service.updateInfluencerProfile("inf-1", {
      ...injected,
      socialMedia: [
        {
          platform: "YouTube",
          handle: "creator123",
          tier: "Micro",
          socialAccountId: ID_A,
          followersCount: 999999,
          ...injected,
        },
      ],
    } as any);

    const [saved] = doc.set.mock.calls.find(
      ([k]: any[]) => k === "socialMedia",
    )[1];
    for (const key of Object.keys(injected)) expect(saved[key]).toBeUndefined();
    expect(saved).toMatchObject({
      socialAccountId: ID_A,
      followersCount: 0,
      handle: "creator123",
      tier: "Micro",
    });
    for (const key of Object.keys(injected)) {
      expect(doc.set.mock.calls.some(([k]: any[]) => k === key)).toBe(false);
    }
  });
});
