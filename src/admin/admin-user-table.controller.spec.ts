import { AdminUserTableController } from "./admin-user-table.controller";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";

// The deleted/active status filter used by the admin user tables (moved here
// from AdminListsController). It doesn't touch `this`, so it's called directly.
const applyAdminUserStatusFilter = (filter: Record<string, any>, status?: string) =>
  (AdminUserTableController.prototype as any).applyAdminUserStatusFilter.call({}, filter, status);

describe("AdminUserTableController status filter", () => {
  it("treats status=deleted as either soft-delete flag or deleted status", () => {
    const filter: Record<string, any> = {};

    applyAdminUserStatusFilter(filter, "deleted");

    expect(filter).toEqual({
      $and: [
        {
          $or: [
            { isDeleted: { $in: [true, "true"] } },
            { status: "deleted" },
          ],
        },
      ],
    });
  });

  it("excludes both deleted markers from active admin lists", () => {
    const filter: Record<string, any> = {};

    applyAdminUserStatusFilter(filter);

    expect(filter).toEqual({
      isDeleted: { $nin: [true, "true"] },
      status: { $ne: "deleted" },
    });
  });
});

describe("AdminUserTableController issueTemporaryPassword", () => {
  // Constructor: 6 models, EarlyAccessAssignmentService, FirebaseAdminService, AuthService (index 8).
  function setup() {
    const authService = {
      issueTemporaryPassword: jest.fn().mockResolvedValue({
        success: true,
        email: "user@test.com",
        expiresAt: new Date("2026-10-01T00:00:00Z"),
      }),
    };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[9] = { reconcile: jest.fn().mockResolvedValue(0) };
    args[8] = authService;
    const controller = new (AdminUserTableController as any)(...args);
    return { controller, authService };
  }

  it("lets a full admin issue one and never returns the password", async () => {
    const { controller, authService } = setup();
    const res = await controller.issueTemporaryPassword("influencer", "u1", {
      user: { role: "admin", userId: "admin-1" },
    });
    expect(authService.issueTemporaryPassword).toHaveBeenCalledWith(
      "influencer",
      "u1",
      "admin-1",
    );
    expect(res).toEqual({
      success: true,
      message: "Temporary password emailed to user@test.com.",
      email: "user@test.com",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
  });

  it("refuses subadmins", async () => {
    const { controller, authService } = setup();
    await expect(
      controller.issueTemporaryPassword("brand", "u1", {
        user: { role: "subadmin", userId: "s1" },
      }),
    ).rejects.toThrow("Only admins can issue temporary passwords.");
    expect(authService.issueTemporaryPassword).not.toHaveBeenCalled();
  });
});

describe("AdminUserTableController social account editing (Stage 3A-0)", () => {
  const ID_A = "64b0000000000000000000a1";
  const ID_B = "64b0000000000000000000b2";
  // Constructor: influencer(0), user(1), brand(2), photographer(3), payment(4), flag(5), earlyAccess(6), firebase(7), auth(8).
  function setup(socialMedia: any[]) {
    const user: any = {
      socialMedia,
      socialMediaEditLog: [],
      adminSocialNotifications: [],
      save: jest.fn(() => Promise.resolve(user)),
    };
    const influencerModel = { findById: jest.fn().mockResolvedValue(user) };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[9] = { reconcile: jest.fn().mockResolvedValue(0) };
    args[0] = influencerModel;
    const controller = new (AdminUserTableController as any)(...args);
    return { controller, user };
  }
  const body = {
    handle: "new.handle",
    tier: "Macro",
    changedBy: "admin-1",
    changedByName: "Asha",
  };

  it("edits the account with that socialAccountId, whatever its position", async () => {
    const { controller, user } = setup([
      {
        socialAccountId: ID_B,
        platform: "YouTube",
        handle: "yt",
        tier: "Nano",
      },
      {
        socialAccountId: ID_A,
        platform: "Instagram",
        handle: "old",
        tier: "Micro",
      },
    ]);

    await controller.patchSocialAccount("influencer", "u1", ID_A, body);

    expect(user.socialMedia[1]).toMatchObject({
      handle: "new.handle",
      tier: "Macro",
    });
    expect(user.socialMedia[0]).toMatchObject({ handle: "yt", tier: "Nano" });
    expect(user.socialMediaEditLog[0]).toMatchObject({
      socialAccountId: ID_A,
      platform: "Instagram",
      oldHandle: "old",
      newHandle: "new.handle",
      oldTier: "Micro",
      newTier: "Macro",
      changedByName: "Asha",
    });
    expect(user.adminSocialNotifications[0]).toMatchObject({
      socialAccountId: ID_A,
      newTier: "Macro",
      seen: false,
    });
    expect(user.save).toHaveBeenCalled();
  });

  it("keeps one latest log/notice per account, replaced by id", async () => {
    const { controller, user } = setup([
      {
        socialAccountId: ID_A,
        platform: "Instagram",
        handle: "old",
        tier: "Micro",
      },
    ]);
    await controller.patchSocialAccount("influencer", "u1", ID_A, body);
    await controller.patchSocialAccount("influencer", "u1", ID_A, {
      tier: "Mid-Tier",
    });
    expect(user.socialMediaEditLog).toHaveLength(1);
    expect(user.adminSocialNotifications).toHaveLength(1);
    expect(user.socialMediaEditLog[0]).toMatchObject({
      oldTier: "Macro",
      newTier: "Mid-Tier",
    });
  });

  it("returns an error instead of editing another account when the id is unknown or invalid", async () => {
    const { controller, user } = setup([
      {
        socialAccountId: ID_A,
        platform: "Instagram",
        handle: "old",
        tier: "Micro",
      },
    ]);
    await expect(
      controller.patchSocialAccount("influencer", "u1", ID_B, body),
    ).rejects.toThrow(/not found/);
    await expect(
      controller.patchSocialAccount("influencer", "u1", "0", body),
    ).rejects.toThrow(/Invalid social account id/);
    expect(user.socialMedia[0].handle).toBe("old");
    expect(user.save).not.toHaveBeenCalled();
  });

  it("legacy position route refuses an entry that already has an id", async () => {
    const { controller, user } = setup([
      {
        socialAccountId: ID_A,
        platform: "Instagram",
        handle: "old",
        tier: "Micro",
      },
    ]);
    await expect(
      controller.patchSocialMediaEntry("influencer", "u1", "0", body),
    ).rejects.toThrow(/refresh/);
    expect(user.save).not.toHaveBeenCalled();
  });

  it("legacy position route still edits a pre-backfill entry and gives it an identity", async () => {
    const { controller, user } = setup([
      { platform: "X / Twitter", handle: "old", tier: "Starter" },
    ]);
    await controller.patchSocialMediaEntry("influencer", "u1", "0", body);
    expect(user.socialMedia[0]).toMatchObject({
      handle: "new.handle",
      tier: "Macro",
      platformKey: "x",
    });
    expect(user.socialMedia[0].socialAccountId).toMatch(/^[a-f0-9]{24}$/);
    expect(user.socialMediaEditLog[0].socialAccountId).toBe(
      user.socialMedia[0].socialAccountId,
    );
  });

  it("rejects an unsupported user type", async () => {
    const { controller } = setup([]);
    await expect(
      controller.patchSocialAccount("admin", "u1", ID_A, body),
    ).rejects.toThrow(/Unsupported user type/);
  });
});

describe("AdminUserTableController explicit creator-tier toggle still works (Stage 3A-0)", () => {
  // Constructor: influencer(0), user(1), brand(2), photographer(3), payment(4), flag(5), earlyAccess(6), firebase(7), auth(8).
  function setup(initial: Record<string, any>) {
    const user: any = {
      _id: "u1",
      verificationStatus: "approved",
      verifiedByTrendStarz: true,
      ...initial,
      save: jest.fn(() => Promise.resolve(user)),
    };
    const flagModel = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }),
      findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })),
      create: jest.fn().mockResolvedValue({}),
    };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[9] = { reconcile: jest.fn().mockResolvedValue(0) };
    args[0] = { findById: jest.fn().mockResolvedValue(user) };
    args[5] = flagModel;
    const controller = new (AdminUserTableController as any)(...args);
    return { controller, user, flagModel };
  }

  it("verifying sets creatorTierVerified and resolves the social/tier flags", async () => {
    const { controller, user, flagModel } = setup({
      creatorTierVerified: false,
    });
    await controller.updateContactVerification("influencer", "u1", {
      creatorTierVerified: true,
    });
    expect(user.creatorTierVerified).toBe(true);
    expect(user.save).toHaveBeenCalled();
    const resolve = flagModel.updateMany.mock.calls.find(([f]: any[]) =>
      f?.flagCode?.$in?.includes("TIER_MISMATCH"),
    );
    expect(resolve).toBeDefined();
    expect(resolve[1].$set.status).toBe("Resolved");
  });

  it("un-verifying clears it and demotes the approval, as before", async () => {
    const { controller, user } = setup({ creatorTierVerified: true });
    await controller.updateContactVerification("influencer", "u1", {
      creatorTierVerified: false,
    });
    expect(user.creatorTierVerified).toBe(false);
    expect(user).toMatchObject({
      verificationStatus: "pending",
      verifiedByTrendStarz: false,
      adminReviewPending: true,
    });
  });
});

describe("AdminUserTableController per-account verification (Stage 3A-1)", () => {
  const ID_A = "64b0000000000000000000a1";
  const ID_B = "64b0000000000000000000b2";
  const adminReq = { user: { role: "admin", userId: "admin-1" } };
  // Constructor: influencer(0), user(1), brand(2), photographer(3), payment(4), flag(5), earlyAccess(6), firebase(7), auth(8), socialAccountVerification(9).
  function setup(
    profile: any,
    type: "influencer" | "brand" | "photographer" = "influencer",
  ) {
    const model = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(profile) })),
      })),
    };
    const verification = {
      decide: jest.fn((actor: any, params: any) =>
        Promise.resolve({ socialAccountId: params.entry.socialAccountId }),
      ),
      listForProfile: jest.fn().mockResolvedValue([{ socialAccountId: ID_A }]),
      reconcile: jest.fn().mockResolvedValue(0),
    };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[{ influencer: 0, brand: 2, photographer: 3 }[type]] = model;
    args[9] = verification;
    const controller = new (AdminUserTableController as any)(...args);
    return { controller, model, verification };
  }
  const accounts = () => [
    { socialAccountId: ID_B, platform: "YouTube", handle: "yt", tier: "Nano" },
    {
      socialAccountId: ID_A,
      platform: "Instagram",
      handle: "ig",
      tier: "Micro",
    },
  ];

  it.each([
    ["decideSocialOwnership", "ownership"],
    ["decideSocialTier", "tier"],
  ])(
    "%s passes the exact account (by id, not position) and the token actor",
    async (method, reviewType) => {
      const profile = { socialMedia: accounts(), creatorTierVerified: true };
      const snapshot = JSON.parse(JSON.stringify(profile));
      const { controller, verification } = setup(profile, "photographer");
      const body = { status: "verified", note: "ok", decidedById: "spoof" };

      const res = await controller[method](
        "photographer",
        "ph-1",
        ID_A,
        body,
        adminReq,
      );

      expect(res).toEqual({
        message: "Social account review saved",
        account: { socialAccountId: ID_A },
      });
      const [actor, params] = verification.decide.mock.calls[0];
      expect(actor).toBe(adminReq.user);
      expect(params).toMatchObject({
        profileType: "Photographer",
        profileId: "ph-1",
        reviewType,
        entry: { socialAccountId: ID_A, handle: "ig" },
        body,
      });
      // The endpoint reads the profile and never writes it (creatorTierVerified included).
      expect(profile).toEqual(snapshot);
    },
  );

  it("400 for a malformed socialAccountId, before any lookup", async () => {
    const { controller, model, verification } = setup({
      socialMedia: accounts(),
    });
    for (const bad of ["0", "not-an-id", `${ID_A}0`, ID_A.toUpperCase()]) {
      await expect(
        controller.decideSocialOwnership(
          "influencer",
          "u1",
          bad,
          { status: "verified" },
          adminReq,
        ),
      ).rejects.toThrow("Invalid social account id");
    }
    expect(model.findById).not.toHaveBeenCalled();
    expect(verification.decide).not.toHaveBeenCalled();
  });

  it("404 for an unknown socialAccountId or profile", async () => {
    const { controller, verification } = setup({
      socialMedia: [accounts()[0]],
    });
    await expect(
      controller.decideSocialTier(
        "influencer",
        "u1",
        ID_A,
        { status: "verified" },
        adminReq,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const missing = setup(null);
    await expect(
      missing.controller.decideSocialTier(
        "influencer",
        "u1",
        ID_A,
        { status: "verified" },
        adminReq,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      missing.controller.listSocialAccountVerifications("influencer", "u1"),
    ).rejects.toMatchObject({ status: 404 });
    expect(verification.decide).not.toHaveBeenCalled();
  });

  it("400 for an unsupported profile type", async () => {
    const { controller } = setup({ socialMedia: accounts() });
    await expect(
      controller.decideSocialOwnership(
        "admin",
        "u1",
        ID_A,
        { status: "verified" },
        adminReq,
      ),
    ).rejects.toThrow("Unsupported user type");
  });

  it("lists effective states for every account on the profile", async () => {
    const profile = { socialMedia: accounts() };
    const { controller, verification } = setup(profile, "brand");
    await expect(
      controller.listSocialAccountVerifications("brand", "b-1"),
    ).resolves.toEqual({ accounts: [{ socialAccountId: ID_A }] });
    expect(verification.listForProfile).toHaveBeenCalledWith(
      "Brand",
      "b-1",
      profile.socialMedia,
    );
  });

  it("an admin handle/tier edit reconciles the saved accounts", async () => {
    const user: any = {
      socialMedia: accounts(),
      socialMediaEditLog: [],
      adminSocialNotifications: [],
      save: jest.fn(() => Promise.resolve(user)),
    };
    const verification = { reconcile: jest.fn().mockResolvedValue(1) };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[0] = { findById: jest.fn().mockResolvedValue(user) };
    args[9] = verification;
    const controller = new (AdminUserTableController as any)(...args);

    await controller.patchSocialAccount("influencer", "u1", ID_A, {
      handle: "ig.new",
    });

    expect(verification.reconcile).toHaveBeenCalledWith(
      "Influencer",
      "u1",
      expect.arrayContaining([
        expect.objectContaining({ socialAccountId: ID_A, handle: "ig.new" }),
      ]),
    );
  });

  it("the whole controller is behind JwtAuthGuard + RolesGuard, and RolesGuard refuses creators", () => {
    const guards = Reflect.getMetadata("__guards__", AdminUserTableController);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);

    const ctx = (user: any) => ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    });
    const guard = new RolesGuard();
    for (const role of ["influencer", "brand", "photographer", undefined]) {
      expect(() => guard.canActivate(ctx({ role }) as any)).toThrow(
        "Admin access only",
      );
    }
    expect(guard.canActivate(ctx({ role: "admin" }) as any)).toBe(true);
    expect(guard.canActivate(ctx({ role: "subadmin" }) as any)).toBe(true);
  });
});

describe("AdminUserTableController platform observation (Stage 3A-2)", () => {
  const ID_A = "64b0000000000000000000a1";
  const ID_B = "64b0000000000000000000b2";
  const adminReq = { user: { role: "admin", userId: "admin-1" } };
  // Constructor: ..., auth(8), socialAccountVerification(9), socialAccountObservation(10).
  function setup(
    profile: any,
    type: "influencer" | "brand" | "photographer" = "influencer",
  ) {
    const model = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(profile) })),
      })),
      findByIdAndUpdate: jest.fn(),
      updateOne: jest.fn(),
    };
    const verification = {
      decide: jest.fn(),
      reconcile: jest.fn(),
      listForProfile: jest.fn(),
    };
    const observation = {
      observe: jest.fn((actor: any, params: any) =>
        Promise.resolve({ socialAccountId: params.entry.socialAccountId }),
      ),
      listForProfile: jest.fn().mockResolvedValue([{ socialAccountId: ID_A }]),
    };
    const args: any[] = Array.from({ length: 11 }, () => ({}));
    args[{ influencer: 0, brand: 2, photographer: 3 }[type]] = model;
    args[9] = verification;
    args[10] = observation;
    const controller = new (AdminUserTableController as any)(...args);
    return { controller, model, verification, observation };
  }
  const accounts = () => [
    { socialAccountId: ID_B, platform: "YouTube", handle: "yt", tier: "Nano" },
    {
      socialAccountId: ID_A,
      platform: "Instagram",
      handle: "ig",
      tier: "Micro",
    },
  ];

  it("observes the account with that exact socialAccountId (not a position) as the token actor", async () => {
    const profile = { socialMedia: accounts() };
    const snapshot = JSON.parse(JSON.stringify(profile));
    const { controller, model, verification, observation } = setup(
      profile,
      "brand",
    );

    const res = await controller.observeSocialAccount(
      "brand",
      "b-1",
      ID_A,
      adminReq,
    );

    expect(res).toEqual({
      message: "Platform observation recorded",
      account: { socialAccountId: ID_A },
    });
    const [actor, params] = observation.observe.mock.calls[0];
    expect(actor).toBe(adminReq.user);
    expect(params).toEqual({
      profileType: "Brand",
      profileId: "b-1",
      entry: expect.objectContaining({ socialAccountId: ID_A, handle: "ig" }),
    });
    // Observation never writes the profile or the 3A-1 verification.
    expect(profile).toEqual(snapshot);
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(verification.decide).not.toHaveBeenCalled();
    expect(verification.reconcile).not.toHaveBeenCalled();
  });

  it("400 for malformed ids, 404 for unknown account / wrong profile, 400 for unsupported type", async () => {
    const { controller, model, observation } = setup({
      socialMedia: [accounts()[0]],
    });
    for (const bad of ["0", "1", "not-an-id", ID_A.toUpperCase()]) {
      await expect(
        controller.observeSocialAccount("influencer", "u1", bad, adminReq),
      ).rejects.toThrow("Invalid social account id");
    }
    expect(model.findById).not.toHaveBeenCalled();
    // ID_A belongs to another profile / isn't on this one.
    await expect(
      controller.observeSocialAccount("influencer", "u1", ID_A, adminReq),
    ).rejects.toMatchObject({
      status: 404,
    });
    const missing = setup(null);
    await expect(
      missing.controller.observeSocialAccount(
        "influencer",
        "u1",
        ID_A,
        adminReq,
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      missing.controller.listSocialAccountObservations("influencer", "u1"),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      controller.observeSocialAccount("admin", "u1", ID_A, adminReq),
    ).rejects.toThrow("Unsupported user type");
    expect(observation.observe).not.toHaveBeenCalled();
  });

  it("lists observations for every account on the profile", async () => {
    const profile = { socialMedia: accounts() };
    const { controller, observation } = setup(profile, "photographer");
    await expect(
      controller.listSocialAccountObservations("photographer", "ph-1"),
    ).resolves.toEqual({
      accounts: [{ socialAccountId: ID_A }],
    });
    expect(observation.listForProfile).toHaveBeenCalledWith(
      "Photographer",
      "ph-1",
      profile.socialMedia,
    );
  });

  it("the observation routes sit on the guarded admin controller", () => {
    const proto = AdminUserTableController.prototype as any;
    expect(Reflect.getMetadata("path", proto.observeSocialAccount)).toBe(
      "users/:type/:id/social-accounts/:socialAccountId/observe",
    );
    expect(
      Reflect.getMetadata("path", proto.listSocialAccountObservations),
    ).toBe("users/:type/:id/social-account-observations");
    expect(Reflect.getMetadata("__guards__", AdminUserTableController)).toEqual(
      [JwtAuthGuard, RolesGuard],
    );
  });
});
