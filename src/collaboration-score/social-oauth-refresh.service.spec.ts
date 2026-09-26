import { SocialOAuthRefreshService } from "./social-oauth-refresh.service";

describe("SocialOAuthRefreshService", () => {
  let service: SocialOAuthRefreshService;
  let connectionModel: any;
  let metaOAuthService: any;

  beforeEach(() => {
    connectionModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    metaOAuthService = { refreshLongLivedToken: jest.fn() };
    service = new SocialOAuthRefreshService(connectionModel, metaOAuthService);
  });

  it("does nothing when no connections are near expiry", async () => {
    const result = await service.refreshExpiringConnections();
    expect(result).toEqual({ refreshed: 0, revoked: 0 });
    expect(metaOAuthService.refreshLongLivedToken).not.toHaveBeenCalled();
  });

  it("only queries non-revoked connections expiring soon", async () => {
    await service.refreshExpiringConnections();
    expect(connectionModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        revokedAt: null,
        longLivedTokenExpiresAt: expect.objectContaining({ $lte: expect.any(Date) }),
      }),
    );
  });

  it("refreshes and updates the token/expiry/lastRefreshedAt for a near-expiry connection", async () => {
    connectionModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: "conn-1", accessToken: "old-token" }]),
      }),
    });
    metaOAuthService.refreshLongLivedToken.mockResolvedValue({ accessToken: "new-token", expiresInSeconds: 5184000 });

    const result = await service.refreshExpiringConnections();

    expect(metaOAuthService.refreshLongLivedToken).toHaveBeenCalledWith("old-token");
    expect(connectionModel.updateOne).toHaveBeenCalledWith(
      { _id: "conn-1" },
      expect.objectContaining({
        $set: expect.objectContaining({ accessToken: "new-token", longLivedTokenExpiresAt: expect.any(Date) }),
      }),
    );
    expect(result).toEqual({ refreshed: 1, revoked: 0 });
  });

  it("marks the connection revoked (not thrown) when refresh fails", async () => {
    connectionModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: "conn-1", accessToken: "old-token" }]),
      }),
    });
    metaOAuthService.refreshLongLivedToken.mockRejectedValue(new Error("invalid token"));

    const result = await service.refreshExpiringConnections();

    expect(connectionModel.updateOne).toHaveBeenCalledWith(
      { _id: "conn-1" },
      { $set: { revokedAt: expect.any(Date) } },
    );
    expect(result).toEqual({ refreshed: 0, revoked: 1 });
  });
});
