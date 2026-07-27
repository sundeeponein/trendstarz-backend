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
