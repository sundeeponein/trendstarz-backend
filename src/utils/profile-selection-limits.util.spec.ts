import { mainCategoryWithin } from "./profile-selection-limits.util";

describe("mainCategoryWithin (main category, 2026-11-15)", () => {
  it("keeps a main category that is one of the creator's categories, in the list's spelling", () => {
    expect(mainCategoryWithin(" food ", ["Fashion", "Food"])).toBe("Food");
  });

  it("clears one that isn't in the list, or when there is no list", () => {
    expect(mainCategoryWithin("Travel", ["Fashion", "Food"])).toBe("");
    expect(mainCategoryWithin("Food", undefined)).toBe("");
    expect(mainCategoryWithin("", ["Food"])).toBe("");
    expect(mainCategoryWithin(null, ["Food"])).toBe("");
  });
});
