import {
  applyDiscoverableProfileFilter,
  getLocationPriorityTier,
  isDiscoverableProfile,
  profileVisibilityAllowsDiscovery,
} from "./profile-eligibility.util";

describe("profile-eligibility shared discovery policy", () => {
  const baseProfile = {
    status: "accepted",
    isDeleted: false,
    accountStatus: "active",
    isEmailVerified: true,
    isMobileVerified: true,
    verificationStatus: "approved",
    verifiedByTrendStarz: false,
    profileVisibility: "PUBLIC",
    profileImages: [{ url: "https://img", public_id: "x" }],
    location: { district: "Pune", state: "Maharashtra", country: "India" },
    socialMedia: [{ platform: "instagram", handle: "@creator", tier: "micro" }],
  };

  it("accepts only discoverable profiles", () => {
    expect(isDiscoverableProfile(baseProfile, { viewerIsAuthenticated: true })).toBe(true);
  });

  it("rejects email-only verified profile", () => {
    const profile = { ...baseProfile, isMobileVerified: false };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects mobile-only verified profile", () => {
    const profile = { ...baseProfile, isEmailVerified: false };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects admin-pending profile", () => {
    const profile = {
      ...baseProfile,
      verificationStatus: "pending",
      verifiedByTrendStarz: false,
    };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects admin-rejected profile", () => {
    const profile = {
      ...baseProfile,
      verificationStatus: "rejected",
      verifiedByTrendStarz: false,
    };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects inactive profile", () => {
    const profile = { ...baseProfile, status: "pending" };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("rejects deleted profile", () => {
    const profile = { ...baseProfile, isDeleted: true };
    expect(isDiscoverableProfile(profile, { viewerIsAuthenticated: true })).toBe(false);
  });

  it("enforces guest visibility rules", () => {
    expect(profileVisibilityAllowsDiscovery("PUBLIC", false)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("MEMBERS_ONLY", false)).toBe(false);
    expect(profileVisibilityAllowsDiscovery("PRIVATE", false)).toBe(false);
  });

  it("enforces logged-in visibility rules", () => {
    expect(profileVisibilityAllowsDiscovery("PUBLIC", true)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("MEMBERS_ONLY", true)).toBe(true);
    expect(profileVisibilityAllowsDiscovery("PRIVATE", true)).toBe(false);
  });

  it("builds discoverable query for guests vs logged in", () => {
    const guestFilter = applyDiscoverableProfileFilter({}, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated: false,
    });
    expect(guestFilter.profileVisibility).toEqual({ $nin: ["PRIVATE", "MEMBERS_ONLY"] });

    const memberFilter = applyDiscoverableProfileFilter({}, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated: true,
    });
    expect(memberFilter.profileVisibility).toEqual({ $nin: ["PRIVATE"] });
  });

  it("applies location tier order district > state > country > remaining", () => {
    const viewer = { district: "Pune", state: "Maharashtra", country: "India" };

    const sameDistrict = {
      location: { district: "Pune", state: "Maharashtra", country: "India" },
    };
    const sameState = {
      location: { district: "Mumbai", state: "Maharashtra", country: "India" },
    };
    const sameCountry = {
      location: { district: "Bengaluru", state: "Karnataka", country: "India" },
    };
    const differentCountry = {
      location: { district: "Dubai", state: "Dubai", country: "UAE" },
    };

    expect(getLocationPriorityTier(sameDistrict, viewer)).toBe(4);
    expect(getLocationPriorityTier(sameState, viewer)).toBe(3);
    expect(getLocationPriorityTier(sameCountry, viewer)).toBe(2);
    expect(getLocationPriorityTier(differentCountry, viewer)).toBe(1);
  });
});
