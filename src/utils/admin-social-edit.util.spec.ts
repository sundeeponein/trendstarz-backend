import { recordSocialEdit } from "./admin-social-edit.util";

describe("recordSocialEdit", () => {
  const user = (tier = "Starter") => ({
    socialMedia: [
      {
        socialAccountId: "64b0000000000000000000a1",
        platformKey: "youtube",
        platform: "YouTube",
        handle: "h",
        tier,
      },
    ],
    socialMediaEditLog: [],
    adminSocialNotifications: [],
  });

  it("a tier change stamps tierChangedAt (rates set before it get flagged for review)", () => {
    const u: any = user();
    recordSocialEdit(u, 0, {
      tier: "Nano",
      changedByName: "Auto (YouTube observation)",
    });
    expect(u.socialMedia[0].tier).toBe("Nano");
    expect(u.socialMedia[0].tierChangedAt).toEqual(expect.any(Date));
    expect(u.adminSocialNotifications[0]).toMatchObject({
      oldTier: "Starter",
      newTier: "Nano",
      seen: false,
    });
  });

  it("a handle-only edit (or the same tier) does not stamp it", () => {
    const u: any = user();
    recordSocialEdit(u, 0, { handle: "new", tier: "Starter" });
    expect(u.socialMedia[0].tierChangedAt).toBeUndefined();
  });
});
