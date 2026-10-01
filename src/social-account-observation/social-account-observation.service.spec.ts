import mongoose from "mongoose";
import { SocialAccountObservationHistorySchema } from "../database/schemas/social-account-observation.schema";
import { ObservationOutcome } from "./platform-observers";
import { SocialAccountObservationService } from "./social-account-observation.service";

const clone = <T>(v: T): T =>
  v == null ? v : (JSON.parse(JSON.stringify(v)) as T);
const revive = (doc: any) => {
  if (!doc) return doc;
  for (const k of ["capturedAt", "lastAttemptAt", "rawPlatformUpdatedAt"]) {
    if (doc[k]) doc[k] = new Date(doc[k]);
  }
  return doc;
};
const matches = (doc: any, f: any) =>
  Object.entries(f).every(([k, v]) => doc[k] === v);
const lean = (v: any) => ({ lean: () => Promise.resolve(v) });

function setup() {
  const current: any[] = [];
  const history: any[] = [];
  const currentModel = {
    findOneAndUpdate: jest.fn((f: any, update: any) => {
      let doc = current.find((d) => matches(d, f));
      if (!doc) {
        doc = {
          ...f,
          observedFollowersCount: null,
          rawPlatformUpdatedAt: null,
          capturedAt: null,
          lastError: null,
        };
        current.push(doc);
      }
      Object.assign(doc, update.$set);
      return Promise.resolve(doc);
    }),
    findOne: jest.fn((f: any) =>
      lean(revive(clone(current.find((d) => matches(d, f)) ?? null))),
    ),
    find: jest.fn((f: any) =>
      lean(current.filter((d) => matches(d, f)).map((d) => revive(clone(d)))),
    ),
  };
  const historyModel = {
    create: jest.fn((doc: any) => {
      history.push(doc);
      return Promise.resolve(doc);
    }),
  };
  const youtube = {
    observe: jest.fn<Promise<ObservationOutcome>, [unknown]>(),
  };
  const meta = {
    observe: jest.fn<
      Promise<ObservationOutcome>,
      [string, string, string, unknown]
    >(),
  };
  const service = new SocialAccountObservationService(
    currentModel as any,
    historyModel as any,
    youtube as any,
    meta as any,
  );
  return {
    service,
    current,
    history,
    currentModel,
    historyModel,
    youtube,
    meta,
  };
}

const ID_YT = "64b0000000000000000000a1";
const ID_IG = "64b0000000000000000000b2";
const admin = { role: "admin", userId: "admin-1" };
const ytEntry = () => ({
  socialAccountId: ID_YT,
  platformKey: "youtube",
  platform: "YouTube",
  handle: "creator123",
  tier: "Micro",
  followersCount: 0,
  selfReportedStats: { avgLikes: 10, avgComments: 2, postFrequencyPerWeek: 3 },
});
const igEntry = () => ({
  socialAccountId: ID_IG,
  platformKey: "instagram",
  platform: "Instagram",
  handle: "creator123",
  tier: "Nano",
});
const base = { profileType: "Influencer" as const, profileId: "inf-1" };
const ytSuccess = (followers: number | null): ObservationOutcome => ({
  ok: true,
  data: {
    source: "youtube",
    externalAccountId: "UCabcdefghijklmnopqrstuv",
    observedHandle: "creator123",
    observedFollowersCount: followers,
    externalUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    rawPlatformUpdatedAt: null,
  },
});

describe("SocialAccountObservationService (Stage 3A-2)", () => {
  afterEach(() => jest.useRealTimers());

  it("records a successful observation tied to the socialAccountId, with server time", async () => {
    const { service, current, history, youtube } = setup();
    youtube.observe.mockResolvedValue(ytSuccess(8450));
    const before = Date.now();
    const view = await service.observe(admin, { ...base, entry: ytEntry() });

    expect(youtube.observe).toHaveBeenCalledWith("creator123");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      profileType: "Influencer",
      profileId: "inf-1",
      socialAccountId: ID_YT,
      platformKey: "youtube",
      source: "youtube",
      externalAccountId: "UCabcdefghijklmnopqrstuv",
      observedHandle: "creator123",
      observedFollowersCount: 8450,
      status: "success",
      lastError: null,
    });
    expect(current[0].capturedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(current[0].lastAttemptAt).toEqual(current[0].capturedAt);
    expect(history).toEqual([
      expect.objectContaining({
        socialAccountId: ID_YT,
        status: "success",
        reason: null,
        observedFollowersCount: 8450,
        requestedById: "admin-1",
        requestedByRole: "admin",
      }),
    ]);
    expect(view).toMatchObject({
      socialAccountId: ID_YT,
      observable: true,
      observation: {
        status: "success",
        lastError: null,
        latest: { observedFollowersCount: 8450, source: "youtube" },
      },
    });
  });

  it("history keeps every observation; the current state is the latest", async () => {
    const { service, current, history, youtube } = setup();
    jest.useFakeTimers();
    for (const [day, followers] of [
      ["2026-09-30", 5000],
      ["2026-10-10", 5800],
      ["2026-10-20", 6400],
    ] as const) {
      jest.setSystemTime(new Date(`${day}T10:00:00.000Z`));
      youtube.observe.mockResolvedValueOnce(ytSuccess(followers));
      await service.observe(admin, { ...base, entry: ytEntry() });
    }
    expect(history.map((h) => h.observedFollowersCount)).toEqual([
      5000, 5800, 6400,
    ]);
    expect(history.map((h) => h.capturedAt.toISOString().slice(0, 10))).toEqual(
      ["2026-09-30", "2026-10-10", "2026-10-20"],
    );
    expect(current).toHaveLength(1);
    expect(current[0].observedFollowersCount).toBe(6400);
    expect(current[0].capturedAt.toISOString()).toBe(
      "2026-10-20T10:00:00.000Z",
    );
  });

  it("a failed attempt is recorded but never erases the last successful observation", async () => {
    const { service, current, history, youtube } = setup();
    youtube.observe.mockResolvedValueOnce(ytSuccess(5000));
    await service.observe(admin, { ...base, entry: ytEntry() });
    const goodCapturedAt = current[0].capturedAt;
    youtube.observe.mockResolvedValueOnce({
      ok: false,
      reason: "rate_limited",
    });
    const view = await service.observe(admin, { ...base, entry: ytEntry() });

    expect(current[0]).toMatchObject({
      status: "failed",
      lastError: "rate_limited",
      observedFollowersCount: 5000,
      externalAccountId: "UCabcdefghijklmnopqrstuv",
      capturedAt: goodCapturedAt,
    });
    expect(history.map((h) => [h.status, h.reason])).toEqual([
      ["success", null],
      ["failed", "rate_limited"],
    ]);
    expect(history[1].observedFollowersCount).toBeUndefined();
    expect(view.observation).toMatchObject({
      status: "failed",
      lastError: "rate_limited",
      latest: { observedFollowersCount: 5000 },
    });
  });

  it("a first-ever failure leaves no observed data", async () => {
    const { service, meta } = setup();
    meta.observe.mockResolvedValue({ ok: false, reason: "account_mismatch" });
    const view = await service.observe(admin, { ...base, entry: igEntry() });
    expect(meta.observe).toHaveBeenCalledWith(
      "instagram",
      "Influencer",
      "inf-1",
      "creator123",
    );
    expect(view.observation).toEqual({
      status: "failed",
      lastError: "account_mismatch",
      lastAttemptAt: expect.any(Date),
      latest: null,
    });
  });

  it("unsupported platforms fail safely without calling any platform", async () => {
    const { service, youtube, meta } = setup();
    const view = await service.observe(admin, {
      ...base,
      entry: { socialAccountId: ID_IG, platform: "LinkedIn", handle: "x" },
    });
    expect(view).toMatchObject({
      platformKey: "linkedin",
      observable: false,
      observation: { status: "failed", lastError: "unsupported_platform" },
    });
    expect(youtube.observe).not.toHaveBeenCalled();
    expect(meta.observe).not.toHaveBeenCalled();
  });

  it("never modifies the declared account (handle, tier, followersCount, selfReportedStats)", async () => {
    const { service, youtube } = setup();
    youtube.observe.mockResolvedValue({
      ok: true,
      data: {
        ...(ytSuccess(50000) as any).data,
        observedHandle: "Creator123.Renamed",
      },
    });
    const entry = ytEntry();
    const original = clone(entry);
    await service.observe(admin, { ...base, entry });
    expect(entry).toEqual(original);
  });

  it("persists only the observed fields — never a token or raw response an observer returns", async () => {
    const { service, current, history, youtube } = setup();
    youtube.observe.mockResolvedValue({
      ok: true,
      data: {
        ...(ytSuccess(1) as any).data,
        accessToken: "leak",
        raw: { a: 1 },
      },
    });
    await service.observe(admin, { ...base, entry: ytEntry() });
    const allowed = new Set([
      "profileType",
      "profileId",
      "socialAccountId",
      "platformKey",
      "source",
      "externalAccountId",
      "observedHandle",
      "observedFollowersCount",
      "externalUrl",
      "rawPlatformUpdatedAt",
      "capturedAt",
      "status",
      "lastError",
      "lastAttemptAt",
      "reason",
      "requestedById",
      "requestedByRole",
    ]);
    for (const doc of [...current, ...history]) {
      for (const key of Object.keys(doc)) expect(allowed.has(key)).toBe(true);
    }
    expect(JSON.stringify([current, history])).not.toContain("leak");
  });

  it.each([
    [{ role: "influencer", userId: "inf-1" }],
    [{ role: "brand" }],
    [undefined],
  ])(
    "refuses non-admin actors (%j) before calling any platform",
    async (actor) => {
      const { service, current, history, youtube } = setup();
      await expect(
        service.observe(actor, { ...base, entry: ytEntry() }),
      ).rejects.toThrow("Admin access only");
      expect(youtube.observe).not.toHaveBeenCalled();
      expect(current).toHaveLength(0);
      expect(history).toHaveLength(0);
    },
  );

  it("allows subadmins", async () => {
    const { service, history, youtube } = setup();
    youtube.observe.mockResolvedValue(ytSuccess(1));
    await service.observe(
      { role: "subadmin", userId: "sub-1" },
      { ...base, entry: ytEntry() },
    );
    expect(history[0]).toMatchObject({
      requestedById: "sub-1",
      requestedByRole: "subadmin",
    });
  });

  it("refuses an entry without a valid socialAccountId", async () => {
    const { service, youtube } = setup();
    await expect(
      service.observe(admin, {
        ...base,
        entry: { platform: "YouTube", handle: "creator123" },
      }),
    ).rejects.toThrow("Invalid social account id");
    expect(youtube.observe).not.toHaveBeenCalled();
  });

  it("lists by socialAccountId for this profile only", async () => {
    const { service, current } = setup();
    current.push({
      profileType: "Influencer",
      profileId: "someone-else",
      socialAccountId: ID_YT,
      status: "success",
      capturedAt: new Date(),
      observedFollowersCount: 1,
    });
    const list = await service.listForProfile("Influencer", "inf-1", [
      ytEntry(),
      igEntry(),
      { platform: "YouTube", handle: "legacy" },
    ]);
    expect(list.map((a) => [a.socialAccountId, a.observation])).toEqual([
      [ID_YT, null],
      [ID_IG, null],
      [null, null],
    ]);
  });

  it("depends only on its own two collections and the platform observers", () => {
    // Constructor arity is the whole dependency surface: no profile, verification
    // or review model can be written from here.
    expect(SocialAccountObservationService.length).toBe(4);
  });
});

describe("social_account_observation_history is append-only", () => {
  const conn = mongoose.createConnection();
  const History = conn.model(
    "ObservationHistoryProbe",
    SocialAccountObservationHistorySchema,
  );
  afterAll(() => conn.close());

  it.each([
    [
      "updateOne",
      () => History.updateOne({}, { $set: { status: "failed" } }).exec(),
    ],
    [
      "updateMany",
      () => History.updateMany({}, { $set: { status: "failed" } }).exec(),
    ],
    [
      "findOneAndUpdate",
      () => History.findOneAndUpdate({}, { status: "failed" }).exec(),
    ],
    ["replaceOne", () => History.replaceOne({}, {}).exec()],
    ["deleteOne", () => History.deleteOne({}).exec()],
    ["deleteMany", () => History.deleteMany({}).exec()],
    ["findOneAndDelete", () => History.findOneAndDelete({}).exec()],
  ])("refuses %s", async (_op, run) => {
    await expect(run()).rejects.toThrow("append-only");
  });

  it("refuses re-saving an existing record", async () => {
    const doc: any = new History({
      profileType: "Influencer",
      profileId: "inf-1",
      socialAccountId: ID_YT,
      status: "success",
      capturedAt: new Date(),
    });
    doc.isNew = false;
    await expect(doc.save()).rejects.toThrow("append-only");
  });
});
