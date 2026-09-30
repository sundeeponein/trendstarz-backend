import { AdminUserTableController } from "./admin-user-table.controller";

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
    const args: any[] = Array.from({ length: 9 }, () => ({}));
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
