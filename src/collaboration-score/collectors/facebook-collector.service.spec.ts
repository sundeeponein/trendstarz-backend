import { FacebookCollectorService } from "./facebook-collector.service";

describe("FacebookCollectorService", () => {
  let service: FacebookCollectorService;
  let connectionModel: any;
  let metaOAuthService: any;

  beforeEach(() => {
    connectionModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      }),
    };
    metaOAuthService = {
      getFacebookPageStats: jest.fn(),
    };
    service = new FacebookCollectorService(connectionModel, metaOAuthService);
  });

  it("falls back to self-reported stats when no OAuth connection exists", async () => {
    const result = await service.collect(
      { handle: "creatorpage", followersCount: 3000, selfReportedStats: { avgLikes: 60, avgComments: 8 } },
      "user-1",
    );

    expect(result?.method).toBe("SELF_REPORTED");
    expect(result?.confidence).toBe(35);
    expect(metaOAuthService.getFacebookPageStats).not.toHaveBeenCalled();
  });

  it("returns null when not connected and no handle/self-reported data exists", async () => {
    const result = await service.collect({}, "user-1");
    expect(result).toBeNull();
  });

  it("uses real Graph API data when connected", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ facebookPageId: "page-1", accessToken: "token-abc" }),
      }),
    });
    metaOAuthService.getFacebookPageStats.mockResolvedValue({
      followersCount: 8000,
      posts: [{ likes: 20, comments: 3, createdAt: new Date() }],
    });

    const result = await service.collect({ handle: "creatorpage" }, "user-1");

    expect(result?.method).toBe("API");
    expect(result?.followersOrSubscribers).toBe(8000);
    expect(result?.confidence).toBe(55); // 1 post -> the ">0" tier
    expect(metaOAuthService.getFacebookPageStats).toHaveBeenCalledWith("page-1", "token-abc");
  });

  it("falls back to self-reported when connected but the Graph API call fails", async () => {
    connectionModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ facebookPageId: "page-1", accessToken: "token-abc" }),
      }),
    });
    metaOAuthService.getFacebookPageStats.mockResolvedValue(null);

    const result = await service.collect(
      { handle: "creatorpage", selfReportedStats: { avgLikes: 20, avgComments: 2 } },
      "user-1",
    );

    expect(result?.method).toBe("SELF_REPORTED");
  });
});
