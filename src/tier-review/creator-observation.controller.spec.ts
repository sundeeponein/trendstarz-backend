import { CreatorObservationController } from "./creator-observation.controller";

describe("CreatorObservationController (creator's own YouTube count)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ID = "64b0000000000000000000a1";
  const yt = (over: Record<string, any> = {}) => ({
    socialAccountId: ID,
    platformKey: "youtube",
    source: "youtube",
    status: "success",
    externalAccountId: "UCabcdefghijklmnopqrstuv",
    observedHandle: "chan",
    observedFollowersCount: 815,
    capturedAt: new Date(Date.now() - 2 * DAY),
    ...over,
  });
  const setup = (
    observations: any[],
    verifications: any[] = [],
    socialMedia: any[] = [
      {
        socialAccountId: ID,
        platformKey: "youtube",
        platform: "YouTube",
        handle: "@chan",
        tier: "Nano",
      },
    ],
  ) => {
    const queries: any[] = [];
    const connection = {
      collection: (name: string) => ({
        findOne: () => Promise.resolve({ socialMedia }),
        find: (q: any) => {
          queries.push([name, q]);
          return {
            toArray: () =>
              Promise.resolve(
                name === "social_account_observations"
                  ? observations
                  : verifications,
              ),
          };
        },
      }),
    };
    return {
      controller: new CreatorObservationController(connection as any),
      queries,
    };
  };

  it("returns only the logged-in creator's recent counts, with the tier they mean", async () => {
    const recent = new Date(Date.now() - 2 * DAY);
    const { controller, queries } = setup(
      [
        yt({ capturedAt: recent }),
        yt({
          socialAccountId: "a2",
          capturedAt: new Date(Date.now() - 40 * DAY),
        }),
      ],
      [{ socialAccountId: ID, tierAutoAppliedAt: recent }],
    );
    const res = await controller.mine({
      user: { role: "influencer", userId: "64b00000000000000000ffff" },
    });
    expect(queries[0][1]).toMatchObject({
      profileType: "Influencer",
      profileId: "64b00000000000000000ffff",
      platformKey: "youtube",
    });
    expect(res.accounts).toEqual([
      {
        socialAccountId: ID,
        platform: "YouTube",
        subscribers: 815,
        capturedAt: recent,
        tier: "Nano",
        declaredTier: "Nano",
        handle: "@chan",
        newHandle: null,
        status: "matches",
        tierAutoUpdatedAt: recent,
      },
    ]);
  });

  it("brands and admins get nothing", async () => {
    const { controller, queries } = setup([
      {
        socialAccountId: "a1",
        observedFollowersCount: 1,
        capturedAt: new Date(),
      },
    ]);
    await expect(
      controller.mine({ user: { role: "brand", userId: "b1" } }),
    ).resolves.toEqual({ accounts: [] });
    expect(queries).toHaveLength(0);
  });

  it("asks the creator to update a different tier, or to check the handle when the channel isn't theirs", async () => {
    const user = {
      user: { role: "photographer", userId: "64b00000000000000000ffff" },
    };
    const differentTier = setup(
      [yt({ observedFollowersCount: 1050 })],
      [],
      [
        {
          socialAccountId: ID,
          platformKey: "youtube",
          platform: "YouTube",
          handle: "@chan",
          tier: "Nano",
        },
      ],
    );
    const [a] = (await differentTier.controller.mine(user)).accounts;
    expect(a).toMatchObject({
      tier: "Micro",
      declaredTier: "Nano",
      status: "please_update",
    });

    const otherChannel = setup([yt({ observedHandle: "someone_else" })]);
    const [b] = (await otherChannel.controller.mine(user)).accounts;
    expect(b.status).toBe("check_handle");
  });

  describe("renamed on YouTube / not found", () => {
    const user = {
      user: { role: "influencer", userId: "64b00000000000000000ffff" },
    };

    it("same channel under a new handle: asks the creator to update the handle (count still shown)", async () => {
      const { controller } = setup([
        yt({ observedHandle: "chan_new", handleChangedTo: "chan_new" }),
      ]);
      const [a] = (await controller.mine(user)).accounts;
      expect(a).toMatchObject({
        status: "handle_renamed",
        newHandle: "chan_new",
        subscribers: 815,
      });
    });

    it("once the creator updated the handle, it is a normal check again", async () => {
      const { controller } = setup(
        [yt({ observedHandle: "chan_new", handleChangedTo: "chan_new" })],
        [],
        [
          {
            socialAccountId: ID,
            platformKey: "youtube",
            platform: "YouTube",
            handle: "@chan_new",
            tier: "Nano",
          },
        ],
      );
      const [a] = (await controller.mine(user)).accounts;
      expect(a.status).toBe("matches");
    });

    it("2 lookups in a row found nothing: 'not found', no count", async () => {
      const failed = (failureCount: number) =>
        yt({
          status: "failed",
          lastError: "external_account_not_found",
          failureCount,
        });
      const once = setup([failed(1)]);
      // A one-off hiccup: the last good count (still < 30 days) keeps showing.
      const [first] = (await once.controller.mine(user)).accounts;
      expect(first).toMatchObject({ status: "matches", subscribers: 815 });
      const twice = setup([failed(2)]);
      const [a] = (await twice.controller.mine(user)).accounts;
      expect(a).toMatchObject({
        status: "not_found",
        subscribers: null,
        handle: "@chan",
      });
    });
  });
});
