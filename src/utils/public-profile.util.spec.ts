import { publicAdminTags } from "./public-profile.util";

describe("publicAdminTags", () => {
  it("keeps public badges and drops commission/test tags, whatever the case or spacing", () => {
    expect(publicAdminTags(["Top Brand", " Partner ", "EARLY ACCESS", "internal/test", "", null])).toEqual(["Top Brand"]);
    expect(publicAdminTags(undefined)).toEqual([]);
  });
});
