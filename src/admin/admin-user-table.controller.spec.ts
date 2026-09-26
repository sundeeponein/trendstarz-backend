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
