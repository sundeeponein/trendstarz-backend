import axios from "axios";
import { MetaGraphError, MetaOAuthService } from "./meta-oauth.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("MetaOAuthService", () => {
  let service: MetaOAuthService;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      META_APP_ID: "app-id",
      META_APP_SECRET: "app-secret",
      META_OAUTH_REDIRECT_URI: "https://example.com/callback",
    };
    service = new MetaOAuthService();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("throws a clear error when Meta credentials are missing", () => {
    process.env.META_APP_ID = "";
    expect(() => service.getAuthorizationUrl("state", ["scope1"])).toThrow(
      "Missing META_APP_ID, META_APP_SECRET, or META_OAUTH_REDIRECT_URI",
    );
  });

  it("isConfigured() reflects whether all three env vars are set", () => {
    expect(service.isConfigured()).toBe(true);
    process.env.META_APP_SECRET = "";
    expect(service.isConfigured()).toBe(false);
  });

  it("builds a correctly-shaped authorization URL", () => {
    const url = service.getAuthorizationUrl("signed-state", ["pages_show_list", "instagram_basic"]);
    expect(url).toContain("https://www.facebook.com/v21.0/dialog/oauth?");
    expect(url).toContain("client_id=app-id");
    expect(url).toContain("state=signed-state");
    expect(url).toContain("scope=pages_show_list%2Cinstagram_basic");
  });

  it("exchangeCodeForToken calls the Graph API with the right params", async () => {
    mockedAxios.get.mockResolvedValue({ data: { access_token: "short-token", expires_in: 3600 } });

    const result = await service.exchangeCodeForToken("auth-code");

    expect(result).toEqual({ accessToken: "short-token", expiresInSeconds: 3600 });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/oauth/access_token"),
      expect.objectContaining({
        params: expect.objectContaining({ code: "auth-code", client_id: "app-id" }),
      }),
    );
  });

  it("exchangeForLongLivedToken uses the fb_exchange_token grant type", async () => {
    mockedAxios.get.mockResolvedValue({ data: { access_token: "long-token", expires_in: 5184000 } });

    const result = await service.exchangeForLongLivedToken("short-token");

    expect(result).toEqual({ accessToken: "long-token", expiresInSeconds: 5184000 });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/oauth/access_token"),
      expect.objectContaining({
        params: expect.objectContaining({ grant_type: "fb_exchange_token", fb_exchange_token: "short-token" }),
      }),
    );
  });

  it("resolveFacebookPages maps the Graph API response, including the linked Instagram account", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            id: "page-1",
            name: "Creator Page",
            followers_count: 1000,
            instagram_business_account: { id: "ig-1" },
          },
        ],
      },
    });

    const pages = await service.resolveFacebookPages("token");

    expect(pages).toEqual([
      { id: "page-1", name: "Creator Page", followersCount: 1000, instagramBusinessAccountId: "ig-1" },
    ]);
  });

  it("resolveFacebookPages returns an empty array (not a throw) when the Graph API call fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network error"));
    const pages = await service.resolveFacebookPages("token");
    expect(pages).toEqual([]);
  });

  it("getFacebookPageStats returns null (not a throw) when the Graph API call fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network error"));
    const stats = await service.getFacebookPageStats("page-1", "token");
    expect(stats).toBeNull();
  });

  it("getInstagramBusinessAccountStats maps username + followers + media into the expected shape", async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { followers_count: 500, username: "creator_handle" } })
      .mockResolvedValueOnce({
        data: { data: [{ like_count: 10, comments_count: 2, timestamp: "2026-01-01T00:00:00Z" }] },
      });

    const stats = await service.getInstagramBusinessAccountStats("ig-1", "token");

    expect(stats?.username).toBe("creator_handle");
    expect(stats?.followersCount).toBe(500);
    expect(stats?.posts).toHaveLength(1);
    expect(stats?.posts[0]).toMatchObject({ likes: 10, comments: 2 });
  });

  it("revokePermissions never throws even if the Graph API call fails", async () => {
    mockedAxios.delete.mockRejectedValue(new Error("network error"));
    await expect(service.revokePermissions("page-1", "token")).resolves.toBeUndefined();
  });

  describe("Stage 3A-2 observation calls", () => {
    const graphError = (code: number, status: number) =>
      Object.assign(new Error("Request failed with access_token=EAAG-secret"), {
        response: {
          status,
          data: {
            error: { code, message: "Invalid OAuth access token EAAG-secret" },
          },
        },
        config: { params: { access_token: "EAAG-secret" } },
      });

    it("fetchInstagramAccount returns id, username and followers", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { id: "178", username: "creator123", followers_count: 8450 },
      });
      await expect(
        service.fetchInstagramAccount("178", "tok"),
      ).resolves.toEqual({
        id: "178",
        username: "creator123",
        followersCount: 8450,
      });
    });

    it("fetchFacebookPages returns every page with its username (no selection)", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: [
            { id: "1", name: "A", username: "a.page", followers_count: 5 },
            { id: "2", name: "B", link: "https://www.facebook.com/b" },
          ],
        },
      });
      await expect(service.fetchFacebookPages("tok")).resolves.toEqual([
        {
          id: "1",
          name: "A",
          username: "a.page",
          link: null,
          followersCount: 5,
        },
        {
          id: "2",
          name: "B",
          username: null,
          link: "https://www.facebook.com/b",
          followersCount: null,
        },
      ]);
      const [, config] = mockedAxios.get.mock.calls[0] as [string, any];
      expect(config.params.fields).toContain("username");
    });

    it.each([
      [
        "fetchInstagramAccount",
        (s: MetaOAuthService) => s.fetchInstagramAccount("178", "EAAG-secret"),
      ],
      [
        "fetchFacebookPages",
        (s: MetaOAuthService) => s.fetchFacebookPages("EAAG-secret"),
      ],
    ])(
      "%s throws a MetaGraphError with codes only — no token, no Meta message",
      async (_n, call) => {
        mockedAxios.get.mockRejectedValueOnce(graphError(190, 400));
        const err: any = await call(service).catch((e) => e);
        expect(err).toBeInstanceOf(MetaGraphError);
        expect(err.graphCode).toBe(190);
        expect(err.httpStatus).toBe(400);
        expect(JSON.stringify({ ...err, message: err.message })).not.toContain(
          "EAAG-secret",
        );
        expect(err.message).not.toContain("Invalid OAuth");
      },
    );
  });
});
