import { InstagramCollectorService } from "./instagram-collector.service";

describe("InstagramCollectorService", () => {
  let service: InstagramCollectorService;
  let connectionModel: any;
  let metaOAuthService: any;

  beforeEach(() => {
    connectionModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    metaOAuthService = {
      getInstagramBusinessAccountStats: jest.fn(),
    };
    service = new InstagramCollectorService(connectionModel, metaOAuthService);
  });

  it("falls back to self-reported stats when no OAuth connection exists", async () => {
    const result = await service.collect(
      {
        handle: "creator",
        followersCount: 5000,
        selfReportedStats: { avgLikes: 100, avgComments: 10 },
      },
      "user-1",
    );

    expect(result?.method).toBe("SELF_REPORTED");
    expect(result?.confidence).toBe(35);
    expect(metaOAuthService.getInstagramBusinessAccountStats).not.toHaveBeenCalled();
  });

  it("returns null when not connected and no handle/self-reported data exists", async () => {
    const result = await service.collect({}, "user-1");
    expect(result).toBeNull();
  });

  it("uses real Graph API data with high confidence when connected and rich in posts", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "conn-1",
          instagramBusinessAccountId: "ig-123",
          accessToken: "token-abc",
          handle: "old_handle",
        }),
      }),
    });
    metaOAuthService.getInstagramBusinessAccountStats.mockResolvedValue({
      username: "creator_handle",
      followersCount: 20000,
      posts: Array.from({ length: 12 }, (_, i) => ({ likes: 100 + i, comments: 10, createdAt: new Date() })),
    });

    const result = await service.collect({ handle: "creator" }, "user-1");

    expect(result?.method).toBe("API");
    expect(result?.handle).toBe("creator_handle");
    expect(result?.followersOrSubscribers).toBe(20000);
    expect(result?.recentPosts).toHaveLength(12);
    expect(result?.confidence).toBe(95);
    expect(metaOAuthService.getInstagramBusinessAccountStats).toHaveBeenCalledWith("ig-123", "token-abc");
  });

  it("refreshes the connection's display-cache (handle/followersCount) on every real audit run", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "conn-1",
          instagramBusinessAccountId: "ig-123",
          accessToken: "token-abc",
          handle: "old_handle",
        }),
      }),
    });
    metaOAuthService.getInstagramBusinessAccountStats.mockResolvedValue({
      username: "creator_handle",
      followersCount: 20000,
      posts: [],
    });

    await service.collect({ handle: "creator" }, "user-1");

    expect(connectionModel.updateOne).toHaveBeenCalledWith(
      { _id: "conn-1" },
      { $set: { handle: "creator_handle", followersCount: 20000 } },
    );
  });

  it("keeps the previous cached handle when the Graph API returns no username", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "conn-1",
          instagramBusinessAccountId: "ig-123",
          accessToken: "token-abc",
          handle: "old_handle",
        }),
      }),
    });
    metaOAuthService.getInstagramBusinessAccountStats.mockResolvedValue({
      username: null,
      followersCount: 20000,
      posts: [],
    });

    await service.collect({ handle: "creator" }, "user-1");

    expect(connectionModel.updateOne).toHaveBeenCalledWith(
      { _id: "conn-1" },
      { $set: { handle: "old_handle", followersCount: 20000 } },
    );
  });

  it("does not let a display-cache refresh failure block the audit result", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: "conn-1",
          instagramBusinessAccountId: "ig-123",
          accessToken: "token-abc",
        }),
      }),
    });
    connectionModel.updateOne.mockRejectedValue(new Error("db down"));
    metaOAuthService.getInstagramBusinessAccountStats.mockResolvedValue({
      username: "creator_handle",
      followersCount: 20000,
      posts: [],
    });

    const result = await service.collect({ handle: "creator" }, "user-1");

    expect(result?.method).toBe("API");
    expect(result?.followersOrSubscribers).toBe(20000);
  });

  it("falls back to self-reported when connected but the Graph API call fails (returns null)", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ instagramBusinessAccountId: "ig-123", accessToken: "token-abc" }),
      }),
    });
    metaOAuthService.getInstagramBusinessAccountStats.mockResolvedValue(null);

    const result = await service.collect(
      { handle: "creator", selfReportedStats: { avgLikes: 50, avgComments: 5 } },
      "user-1",
    );

    expect(result?.method).toBe("SELF_REPORTED");
  });

  it("ignores a revoked connection (query already filters revokedAt: null, sanity check the filter is applied)", async () => {
    await service.collect({ handle: "creator" }, "user-1");
    expect(connectionModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", platform: "instagram", revokedAt: null }),
    );
  });
});
