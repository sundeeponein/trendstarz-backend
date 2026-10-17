import { UsersService } from "./users.service";

/** Profile page for a viewer who can't see social links (e.g. not Premium). */
describe("UsersService.getInfluencerByUsername — restricted viewers still see the tier", () => {
  const make = (allowSocial: boolean) => {
    const service: any = Object.create(UsersService.prototype);
    service.influencerModel = {
      findOne: () => ({
        lean: () =>
          Promise.resolve({
            _id: "inf1",
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
});
