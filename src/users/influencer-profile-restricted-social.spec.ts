import { UsersService } from "./users.service";

/** Profile page for a viewer who can't see social links (e.g. not Premium). */
describe("UsersService.getInfluencerByUsername — restricted viewers still see the tier", () => {
  const make = (allowSocial: boolean, extra: Record<string, unknown> = {}) => {
    const service: any = Object.create(UsersService.prototype);
    service.influencerModel = {
      findOne: () => ({
        lean: () =>
          Promise.resolve({
            _id: "inf1",
            status: "accepted", // a live, public creator
            ...extra,
            name: "Asha",
            username: "asha",
            socialMedia: [
              {
                socialAccountId: "64b0000000000000000000a1",
                platform: "YouTube",
                platformKey: "youtube",
                handle: "asha_channel",
                url: "https://youtube.com/@asha_channel",
                tier: "Micro",
                contentTypes: [{ name: "Shorts", enabled: true, price: 800 }],
              },
            ],
          }),
      }),
    };
    service.influencerModel.findById = service.influencerModel.findOne;
    service.hasOpenPublicProfileBlock = () => Promise.resolve(false);
    service.hasOpenGalleryBlock = () => Promise.resolve(false);
    service.canViewInfluencerContact = () => Promise.resolve(false);
    service.canViewInfluencerGender = () => Promise.resolve(false);
    service.plansService = {
      canViewSocialLinks: () => Promise.resolve(allowSocial),
    };
    return service as UsersService;
  };

  it("restricted: platform + tier only — no handle, link or rates", async () => {
    const res: any = await make(false).getInfluencerByUsername("asha", null);
    expect(res.socialMediaRestricted).toBe(true);
    expect(res.socialMedia).toEqual([
      { platform: "YouTube", platformKey: "youtube", tier: "Micro" },
    ]);
    expect(JSON.stringify(res.socialMedia)).not.toContain("asha_channel");
  });

  it("allowed: the full accounts, as before", async () => {
    const res: any = await make(true).getInfluencerByUsername(
      "asha",
      "viewer1",
    );
    expect(res.socialMedia[0]).toMatchObject({
      handle: "asha_channel",
      contentTypes: [expect.anything()],
    });
  });

  it("a Private or pending profile opens only for its owner and admins", async () => {
    const owner = { userId: "inf1", role: "influencer" };
    const brand = { userId: "b1", role: "brand" };
    const admin = { userId: "a1", role: "admin" };
    const priv = make(true, { profileVisibility: "PRIVATE" });
    expect(await priv.getInfluencerByUsername("asha", null, null)).toBeNull();
    expect(await priv.getInfluencerByUsername("asha", "b1", brand)).toBeNull();
    expect(await priv.getInfluencerByUsername("asha", "inf1", owner)).toMatchObject({ username: "asha" });
    expect(await priv.getInfluencerByUsername("asha", "a1", admin)).toMatchObject({ username: "asha" });
    expect(await priv.getInfluencerById("inf1", null, null)).toBeNull();
    const pending = make(true, { status: "pending" });
    expect(await pending.getInfluencerByUsername("asha", "b1", brand)).toBeNull();
    const members = make(true, { profileVisibility: "MEMBERS_ONLY" });
    expect(await members.getInfluencerByUsername("asha", null, null)).toBeNull();
    expect(await members.getInfluencerByUsername("asha", "b1", brand)).toMatchObject({ username: "asha" });
  });
});
