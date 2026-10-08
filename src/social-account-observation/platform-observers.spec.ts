import axios from "axios";
import { MetaGraphError } from "../meta-oauth/meta-oauth.service";
import {
  MetaObserver,
  YoutubeObserver,
  normalizeFacebookPageRef,
  normalizeInstagramHandle,
  parseYouTubeIdentifier,
} from "./platform-observers";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv"; // UC + 22
const OTHER_CHANNEL_ID = "UCzzzzzzzzzzzzzzzzzzzzzz";
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    YOUTUBE_API_KEY: "yt-secret-key",
    META_APP_ID: "app",
    META_APP_SECRET: "secret",
    META_OAUTH_REDIRECT_URI: "https://example.com/cb",
  };
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("parseYouTubeIdentifier (exact identifiers only)", () => {
  it.each([
    ["creator123", "creator123"],
    ["@creator123", "creator123"],
    ["  @Creator123 ", "Creator123"],
    ["https://youtube.com/@creator123", "creator123"],
    ["https://www.youtube.com/@creator123/videos", "creator123"],
    ["youtube.com/@creator123", "creator123"],
    ["https://m.youtube.com/@creator.123", "creator.123"],
  ])("%p → handle %p", (raw, value) => {
    expect(parseYouTubeIdentifier(raw)).toEqual({ kind: "handle", value });
  });

  it.each([
    [CHANNEL_ID],
    [`https://www.youtube.com/channel/${CHANNEL_ID}`],
    [`youtube.com/channel/${CHANNEL_ID}/`],
  ])("%p → channel id", (raw) => {
    expect(parseYouTubeIdentifier(raw)).toEqual({
      kind: "channelId",
      value: CHANNEL_ID,
    });
  });

  it("keeps different handles different (no fuzzy normalisation)", () => {
    expect(parseYouTubeIdentifier("creator123")).not.toEqual(
      parseYouTubeIdentifier("creator1234"),
    );
  });

  it.each([
    "",
    "Creator Name With Spaces",
    "https://youtube.com/c/legacyname",
    "https://youtube.com/user/legacyname",
    "https://youtube.com/watch?v=abc",
    "https://notyoutube.com/@creator123",
    "https://youtube.com.evil.com/@creator123",
    "@@creator",
    "ab",
    "creator/123",
  ])("%p is not an exact identifier", (raw) => {
    expect(parseYouTubeIdentifier(raw)).toBeNull();
  });
});

describe("YoutubeObserver", () => {
  const observer = new YoutubeObserver();
  const channel = (over: any = {}) => ({
    id: CHANNEL_ID,
    snippet: { customUrl: "@creator123", title: "Creator 123" },
    statistics: { subscriberCount: "8450", hiddenSubscriberCount: false },
    ...over,
  });
  const respond = (items: any[]) =>
    mockedAxios.get.mockResolvedValueOnce({ data: { items } });

  it("exact handle lookup: success with external id, handle, followers and URL", async () => {
    respond([channel()]);
    const out = await observer.observe("@Creator123");
    expect(out).toEqual({
      ok: true,
      data: {
        source: "youtube",
        externalAccountId: CHANNEL_ID,
        observedHandle: "creator123",
        observedFollowersCount: 8450,
        externalUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
        rawPlatformUpdatedAt: null,
      },
    });
    const [url, config] = mockedAxios.get.mock.calls[0] as [string, any];
    expect(url).toBe("https://www.googleapis.com/youtube/v3/channels");
    expect(config.params).toMatchObject({ forHandle: "@Creator123" });
    expect(config.params.id).toBeUndefined();
  });

  it("exact channel id lookup", async () => {
    respond([channel()]);
    const out = await observer.observe(
      `https://www.youtube.com/channel/${CHANNEL_ID}`,
    );
    expect(out).toMatchObject({
      ok: true,
      data: { externalAccountId: CHANNEL_ID },
    });
    const [, config] = mockedAxios.get.mock.calls[0] as [string, any];
    expect(config.params).toMatchObject({ id: CHANNEL_ID });
    expect(config.params.forHandle).toBeUndefined();
  });

  it("hidden subscriber count is stored as null, not 0", async () => {
    respond([channel({ statistics: { hiddenSubscriberCount: true } })]);
    const out: any = await observer.observe("creator123");
    expect(out.ok).toBe(true);
    expect(out.data.observedFollowersCount).toBeNull();
  });

  it("never calls search.list — not even when the exact lookup finds nothing", async () => {
    respond([]);
    const out = await observer.observe("creator123");
    expect(out).toEqual({ ok: false, reason: "external_account_not_found" });
    expect(mockedAxios.get.mock.calls).toHaveLength(1);
    for (const [url] of mockedAxios.get.mock.calls) {
      expect(String(url)).not.toContain("/search");
    }
  });

  it("rejects an ambiguous response instead of taking the first result", async () => {
    respond([channel(), channel({ id: OTHER_CHANNEL_ID })]);
    expect(await observer.observe("creator123")).toEqual({
      ok: false,
      reason: "external_account_not_found",
    });
  });

  it("rejects a handle lookup that returns a different handle", async () => {
    respond([channel({ snippet: { customUrl: "@creator1234" } })]);
    expect(await observer.observe("creator123")).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("rejects a handle lookup whose channel has no handle to confirm", async () => {
    respond([channel({ snippet: {} })]);
    expect(await observer.observe("creator123")).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("rejects an id lookup that returns another channel", async () => {
    respond([channel({ id: OTHER_CHANNEL_ID })]);
    expect(await observer.observe(CHANNEL_ID)).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("does not call the API for a non-exact declared value", async () => {
    expect(await observer.observe("My Channel Name")).toEqual({
      ok: false,
      reason: "external_account_not_found",
    });
    expect(mockedAxios.get.mock.calls).toHaveLength(0);
  });

  it("reports platform_not_configured without a key", async () => {
    delete process.env.YOUTUBE_API_KEY;
    expect(await observer.observe("creator123")).toEqual({
      ok: false,
      reason: "platform_not_configured",
    });
    expect(mockedAxios.get.mock.calls).toHaveLength(0);
  });

  it.each([
    [
      {
        status: 403,
        data: { error: { errors: [{ reason: "quotaExceeded" }] } },
      },
      "rate_limited",
    ],
    [{ status: 429, data: {} }, "rate_limited"],
    [{ status: 500, data: {} }, "platform_api_error"],
    [undefined, "platform_api_error"],
  ])(
    "API failure %j → %s, and the API key is never logged",
    async (response, reason) => {
      const warn = jest
        .spyOn((observer as any).logger, "warn")
        .mockImplementation(() => undefined);
      mockedAxios.get.mockRejectedValueOnce(
        Object.assign(new Error("Request failed"), {
          response,
          config: { params: { key: "yt-secret-key" } },
        }),
      );
      expect(await observer.observe("creator123")).toEqual({
        ok: false,
        reason,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("yt-secret-key");
      warn.mockRestore();
    },
  );
});

describe("Meta handle normalisation", () => {
  it.each([
    ["creator123", "creator123"],
    ["@Creator123", "creator123"],
    ["https://www.instagram.com/creator123/", "creator123"],
    ["instagram.com/creator.123?igsh=x", "creator.123"],
  ])("instagram %p → %p", (raw, out) => {
    expect(normalizeInstagramHandle(raw)).toBe(out);
  });

  it.each(["", "creator name", "https://evil.com/creator123", "a/b"])(
    "instagram %p → null",
    (raw) => expect(normalizeInstagramHandle(raw)).toBeNull(),
  );

  it.each([
    ["mypage.official", "mypage.official"],
    ["https://facebook.com/MyPage.Official", "mypage.official"],
    ["https://www.facebook.com/profile.php?id=1000123456", "1000123456"],
    ["https://facebook.com/pages/My-Page/1234567890", "1234567890"],
  ])("facebook %p → %p", (raw, out) => {
    expect(normalizeFacebookPageRef(raw)).toBe(out);
  });

  it.each(["My Page Name", "", "abc", "https://evil.com/mypage"])(
    "facebook %p → null (display names never match)",
    (raw) => expect(normalizeFacebookPageRef(raw)).toBeNull(),
  );
});

describe("MetaObserver", () => {
  const IG_ID = "17841400000000001";
  function setup(connection: any) {
    const connectionModel = {
      findOne: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue(connection),
        })),
      })),
    };
    const metaOAuthService = {
      isConfigured: jest.fn(() => true),
      fetchInstagramAccount: jest.fn(),
      fetchFacebookPages: jest.fn(),
    };
    const observer = new MetaObserver(
      connectionModel as any,
      metaOAuthService as any,
    );
    jest
      .spyOn((observer as any).logger, "warn")
      .mockImplementation(() => undefined);
    return { observer, connectionModel, metaOAuthService };
  }
  const igConnection = {
    accessToken: "EAAG-secret-token",
    instagramBusinessAccountId: IG_ID,
  };

  it("looks up the connection for this exact profile, profile type and platform", async () => {
    const { observer, connectionModel, metaOAuthService } = setup(igConnection);
    metaOAuthService.fetchInstagramAccount.mockResolvedValue({
      id: IG_ID,
      username: "creator123",
      followersCount: 8450,
    });
    await observer.observe("instagram", "Influencer", "inf-1", "@creator123");
    expect(connectionModel.findOne).toHaveBeenCalledWith({
      userId: "inf-1",
      userType: "Influencer",
      platform: "instagram",
      revokedAt: null,
    });
  });

  it("instagram: accepts the declared account and returns no token", async () => {
    const { observer, metaOAuthService } = setup(igConnection);
    metaOAuthService.fetchInstagramAccount.mockResolvedValue({
      id: IG_ID,
      username: "Creator123",
      followersCount: 8450,
    });
    const out = await observer.observe(
      "instagram",
      "Influencer",
      "inf-1",
      "https://instagram.com/creator123",
    );
    expect(out).toEqual({
      ok: true,
      data: {
        source: "instagram",
        externalAccountId: IG_ID,
        observedHandle: "Creator123",
        observedFollowersCount: 8450,
        externalUrl: "https://www.instagram.com/Creator123/",
        rawPlatformUpdatedAt: null,
      },
    });
    expect(JSON.stringify(out)).not.toContain("EAAG-secret-token");
  });

  it("instagram: a different connected account is account_mismatch, never a success", async () => {
    const { observer, metaOAuthService } = setup(igConnection);
    metaOAuthService.fetchInstagramAccount.mockResolvedValue({
      id: IG_ID,
      username: "another_creator",
      followersCount: 99999,
    });
    expect(
      await observer.observe("instagram", "Influencer", "inf-1", "creator123"),
    ).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("instagram: no connection / no token / no IG account → authorization_required", async () => {
    for (const connection of [
      null,
      { instagramBusinessAccountId: IG_ID },
      { accessToken: "t" },
    ]) {
      const { observer } = setup(connection);
      expect(
        await observer.observe(
          "instagram",
          "Influencer",
          "inf-1",
          "creator123",
        ),
      ).toEqual({
        ok: false,
        reason: "authorization_required",
      });
    }
  });

  it.each([
    [new MetaGraphError(190, 400), "authorization_required"],
    [new MetaGraphError(200, 403), "authorization_required"],
    [new MetaGraphError(4, 400), "rate_limited"],
    [new MetaGraphError(2, 500), "platform_api_error"],
    [new Error("boom"), "platform_api_error"],
  ])("instagram: %s → %s", async (err, reason) => {
    const { observer, metaOAuthService } = setup(igConnection);
    metaOAuthService.fetchInstagramAccount.mockRejectedValue(err);
    expect(
      await observer.observe("instagram", "Influencer", "inf-1", "creator123"),
    ).toEqual({
      ok: false,
      reason,
    });
  });

  const page = (id: string, username: string | null, followersCount = 100) => ({
    id,
    name: `Page ${id}`,
    username,
    link: `https://www.facebook.com/${username || id}`,
    followersCount,
  });

  it("facebook: picks the page matching the declared username, not pages[0]", async () => {
    const { observer, metaOAuthService } = setup({ accessToken: "tok" });
    metaOAuthService.fetchFacebookPages.mockResolvedValue([
      page("111111", "otherpage", 50),
      page("222222", "mypage.official", 3200),
    ]);
    const out = await observer.observe(
      "facebook",
      "Brand",
      "b-1",
      "https://facebook.com/MyPage.Official",
    );
    expect(out).toMatchObject({
      ok: true,
      data: {
        source: "facebook",
        externalAccountId: "222222",
        observedHandle: "mypage.official",
        observedFollowersCount: 3200,
      },
    });
  });

  it("facebook: matches by numeric page id", async () => {
    const { observer, metaOAuthService } = setup({ accessToken: "tok" });
    metaOAuthService.fetchFacebookPages.mockResolvedValue([
      page("111111", null),
      page("1234567890", null, 77),
    ]);
    const out: any = await observer.observe(
      "facebook",
      "Influencer",
      "inf-1",
      "https://www.facebook.com/profile.php?id=1234567890",
    );
    expect(out.data).toMatchObject({
      externalAccountId: "1234567890",
      observedFollowersCount: 77,
    });
  });

  it("facebook: several pages and none matching → account_mismatch (no arbitrary choice)", async () => {
    const { observer, metaOAuthService } = setup({ accessToken: "tok" });
    metaOAuthService.fetchFacebookPages.mockResolvedValue([
      page("111111", "firstpage"),
      page("222222", "secondpage"),
    ]);
    expect(
      await observer.observe(
        "facebook",
        "Influencer",
        "inf-1",
        "mypage.official",
      ),
    ).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("facebook: a single page that isn't the declared one is still rejected", async () => {
    const { observer, metaOAuthService } = setup({ accessToken: "tok" });
    metaOAuthService.fetchFacebookPages.mockResolvedValue([
      page("111111", "firstpage"),
    ]);
    expect(
      await observer.observe(
        "facebook",
        "Influencer",
        "inf-1",
        "mypage.official",
      ),
    ).toEqual({
      ok: false,
      reason: "account_mismatch",
    });
  });

  it("facebook: a display name never matches (declared value isn't a page reference)", async () => {
    const { observer, metaOAuthService } = setup({ accessToken: "tok" });
    expect(
      await observer.observe("facebook", "Influencer", "inf-1", "Page 111111"),
    ).toEqual({
      ok: false,
      reason: "external_account_not_found",
    });
    expect(metaOAuthService.fetchFacebookPages).not.toHaveBeenCalled();
  });

  it("not configured → platform_not_configured without touching the DB", async () => {
    const { observer, connectionModel, metaOAuthService } = setup(igConnection);
    metaOAuthService.isConfigured.mockReturnValue(false);
    expect(
      await observer.observe("instagram", "Influencer", "inf-1", "creator123"),
    ).toEqual({
      ok: false,
      reason: "platform_not_configured",
    });
    expect(connectionModel.findOne).not.toHaveBeenCalled();
  });
});

describe("MetaObserver.connectedPlatforms", () => {
  function setup(rows: any[]) {
    const select = jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) }));
    const connectionModel = { find: jest.fn(() => ({ select })) };
    const observer = new MetaObserver(
      connectionModel as any,
      { isConfigured: () => true } as any,
    );
    return { observer, connectionModel, select };
  }

  it("only counts live connections with a token, for this exact profile — without selecting the token", async () => {
    const { observer, connectionModel, select } = setup([]);
    await observer.connectedPlatforms("Brand", "b-1");
    expect(connectionModel.find).toHaveBeenCalledWith({
      userId: "b-1",
      userType: "Brand",
      platform: { $in: ["instagram", "facebook"] },
      revokedAt: null,
      accessToken: { $exists: true, $nin: [null, ""] },
    });
    const [fields] = select.mock.calls[0] as unknown as [string];
    expect(fields).not.toContain("accessToken");
  });

  it("Instagram counts only with a linked Instagram Business account", async () => {
    expect([
      ...(await setup([
        { platform: "instagram", instagramBusinessAccountId: null },
      ]).observer.connectedPlatforms("Influencer", "i")),
    ]).toEqual([]);
    expect(
      [
        ...(await setup([
          { platform: "instagram", instagramBusinessAccountId: "178" },
          { platform: "facebook", facebookPageId: "1" },
        ]).observer.connectedPlatforms("Influencer", "i")),
      ].sort(),
    ).toEqual(["facebook", "instagram"]);
  });
});
