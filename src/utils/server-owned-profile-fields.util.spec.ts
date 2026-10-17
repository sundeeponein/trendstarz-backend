import {
  SERVER_OWNED_PROFILE_FIELDS,
  withoutServerOwnedProfileFields,
} from "./server-owned-profile-fields.util";

describe("withoutServerOwnedProfileFields", () => {
  it("drops approval, Premium, commission and verification claims from a signup form", () => {
    const clean = withoutServerOwnedProfileFields({
      name: "Asha",
      email: "a@b.com",
      categories: ["Food"],
      status: "accepted",
      isPremium: true,
      premiumEnd: new Date("2099-01-01"),
      commissionOverride: { enabled: true, overrideType: "waiver" },
      isEmailVerified: true,
      isMobileVerified: true,
      verifiedByTrendStarz: true,
      profileTier: "Outstanding Profile",
      firebaseUid: "someone-elses-uid",
    });
    expect(clean).toEqual({ name: "Asha", email: "a@b.com", categories: ["Food"] });
  });

  it("covers the fields that grant access or money", () => {
    for (const field of [
      "status",
      "isPremium",
      "premiumEnd",
      "commissionOverride",
      "isEmailVerified",
      "isMobileVerified",
      "verifiedByTrendStarz",
      "approvedAt",
      "role",
      "firebaseUid",
      "mustChangePassword",
    ]) {
      expect(SERVER_OWNED_PROFILE_FIELDS).toContain(field);
    }
  });
});
