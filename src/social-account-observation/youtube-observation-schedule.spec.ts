import mongoose from "mongoose";
import {
  SocialAccountObservationHistorySchema,
  YOUTUBE_STATISTICS_PURGE_OPTION,
  isYoutubeStatisticsPurge,
} from "../database/schemas/social-account-observation.schema";
import { SocialAccountObservationService } from "./social-account-observation.service";
import {
  YOUTUBE_SCHEDULE,
  accountKey,
  consecutiveIdentityFailures,
  isInObservationPopulation,
  planYoutubeObservationRun,
} from "./youtube-observation-schedule";
import {
  SCHEDULE_ENV_FLAG,
  YoutubeObservationSchedulerService,
} from "./youtube-observation-scheduler.service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-06T21:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const YT = (n: number) => `64b0000000000000000000${String(n).padStart(2, "0")}`;

const approved = (
  id: string,
  socialMedia: any[],
  over: Record<string, any> = {},
) => ({
  _id: id,
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  socialMedia,
  ...over,
});
const yt = (n: number, handle = `@chan${n}`) => ({
  socialAccountId: YT(n),
  platformKey: "youtube",
  platform: "YouTube",
  handle,
  tier: "Micro",
});
const ig = (n: number) => ({
  socialAccountId: YT(n),
  platformKey: "instagram",
  platform: "Instagram",
  handle: "insta",
});

const plan = (
  profiles: Array<Record<string, any>>,
  current: Array<[string, string, Record<string, any>]> = [],
  history: Array<[string, string, any[]]> = [],
) =>
  planYoutubeObservationRun({
    now: NOW,
    profiles: profiles.map((profile) => ({
      profileType: "Influencer" as const,
      profile,
    })),
    current: new Map(
      current.map(([pid, sid, d]) => [accountKey("Influencer", pid, sid), d]),
    ),
    history: new Map(
      history.map(([pid, sid, h]) => [accountKey("Influencer", pid, sid), h]),
    ),
  });

describe("Stage 3D-1a — observation population (approved + pending review)", () => {
  it.each([
    ["approved & active", approved("a", []), true],
    [
      "awaiting review (verificationStatus pending)",
      approved("a", [], { verificationStatus: "pending" }),
      true,
    ],
    [
      "awaiting review (adminReviewPending)",
      approved("a", [], {
        verificationStatus: "not_submitted",
        adminReviewPending: true,
      }),
      true,
    ],
    [
      "not submitted, not approved",
      approved("a", [], { verificationStatus: "not_submitted" }),
      false,
    ],
    ["rejected", approved("a", [], { verificationStatus: "rejected" }), false],
    ["deleted", approved("a", [], { isDeleted: true }), false],
    [
      "declined account",
      approved("a", [], { status: "declined", verificationStatus: "pending" }),
      false,
    ],
    ["suspended", approved("a", [], { accountStatus: "suspended" }), false],
  ])("%s", (_l, profile, expected) => {
    expect(isInObservationPopulation(profile)).toBe(expected);
  });
});

describe("Stage 3D-1a — run plan", () => {
  it("only YouTube accounts with a valid id in the population are candidates", () => {
    const p = plan([
      approved("a", [yt(1), ig(2), { ...yt(3), socialAccountId: "bad" }]),
      approved("b", [yt(4)], { verificationStatus: "rejected" }),
      approved("c", [
        { ...yt(5), platformKey: undefined, platform: " YouTube " },
      ]),
    ]);
    expect(p.candidates).toBe(2);
    expect(
      p.due.map((d) => [d.profileId, d.socialAccountId, d.reason]),
    ).toEqual([
      ["a", YT(1), "never_observed"],
      ["c", YT(5), "never_observed"],
    ]);
  });

  it("weekly refresh: a success is due again after 7 days, not before", () => {
    const p = plan(
      [approved("a", [yt(1), yt(2)])],
      [
        [
          "a",
          YT(1),
          { status: "success", lastError: null, lastAttemptAt: daysAgo(7) },
        ],
        [
          "a",
          YT(2),
          { status: "success", lastError: null, lastAttemptAt: daysAgo(6.9) },
        ],
      ],
    );
    expect(p.due.map((d) => [d.socialAccountId, d.reason])).toEqual([
      [YT(1), "refresh"],
    ]);
    expect(p.notDue).toBe(1);
  });

  it("a failure is retried after a day", () => {
    const failed = (at: Date) => ({
      status: "failed",
      lastError: "platform_api_error",
      lastAttemptAt: at,
    });
    const p = plan(
      [approved("a", [yt(1), yt(2)])],
      [
        ["a", YT(1), failed(daysAgo(1))],
        ["a", YT(2), failed(daysAgo(0.5))],
      ],
    );
    expect(p.due.map((d) => [d.socialAccountId, d.reason])).toEqual([
      [YT(1), "retry"],
    ]);
    expect(p.notDue).toBe(1);
  });

  it("pauses after 3 consecutive wrong-account failures, retries monthly, and lists it for admins", () => {
    const miss = (d: number) => ({
      status: "failed",
      reason: "external_account_not_found",
      capturedAt: daysAgo(d),
    });
    const history = [
      miss(2),
      miss(3),
      miss(4),
      { status: "success", reason: null, capturedAt: daysAgo(10) },
    ];
    expect(consecutiveIdentityFailures(history)).toBe(3);
    expect(
      consecutiveIdentityFailures([
        { status: "failed", reason: "rate_limited", capturedAt: NOW },
        ...history,
      ]),
    ).toBe(0);
    const doc = (at: Date) => ({
      status: "failed",
      lastError: "external_account_not_found",
      lastAttemptAt: at,
    });

    const p = plan(
      [approved("a", [yt(1)])],
      [["a", YT(1), doc(daysAgo(2))]],
      [["a", YT(1), history]],
    );
    expect(p.due).toEqual([]);
    expect(p.paused).toHaveLength(1);
    expect(p.paused[0]).toMatchObject({
      consecutiveFailures: 3,
      lastError: "external_account_not_found",
    });
    expect(p.paused[0].nextRetryAt.toISOString()).toBe(
      new Date(
        daysAgo(2).getTime() + YOUTUBE_SCHEDULE.pausedRetryAfterDays * DAY,
      ).toISOString(),
    );

    const later = plan(
      [approved("a", [yt(1)])],
      [["a", YT(1), doc(daysAgo(30))]],
      [["a", YT(1), history]],
    );
    expect(later.due.map((d) => d.reason)).toEqual(["paused_retry"]);
  });

  it("orders never-observed first, then oldest attempt, and caps each run", () => {
    const accounts = Array.from(
      { length: YOUTUBE_SCHEDULE.maxCallsPerRun + 5 },
      (_, i) => yt(i % 100, `@c${i}`),
    ).map((a, i) => ({
      ...a,
      socialAccountId: `64b${String(i).padStart(21, "0")}`,
    }));
    const current: Array<[string, string, any]> = accounts
      .slice(0, 3)
      .map((a, i) => [
        "a",
        a.socialAccountId,
        { status: "success", lastAttemptAt: daysAgo(10 + i) },
      ]);
    const p = plan([approved("a", accounts)], current);
    expect(p.due).toHaveLength(YOUTUBE_SCHEDULE.maxCallsPerRun);
    expect(p.deferred).toBe(5);
    // 102 never-observed accounts outrank the 3 refreshes; the cap keeps the first 100.
    expect(p.due.every((d) => d.reason === "never_observed")).toBe(true);
    const ids = p.due.map((d) => d.socialAccountId);
    expect(ids).toEqual([...ids].sort());
    // Deterministic for the same input.
    expect(JSON.stringify(plan([approved("a", accounts)], current))).toBe(
      JSON.stringify(p),
    );
  });
});

describe("Stage 3D-1a — observation service: system path and retention purge", () => {
  const setup = () => {
    const history: any[] = [];
    const currentModel = {
      findOneAndUpdate: jest.fn(() => Promise.resolve({})),
      findOne: jest.fn(() => ({
        lean: () =>
          Promise.resolve({
            status: "success",
            lastError: null,
            lastAttemptAt: NOW,
            capturedAt: NOW,
          }),
      })),
      updateMany: jest.fn(() => Promise.resolve({ modifiedCount: 2 })),
    };
    const historyModel = {
      create: jest.fn((d: any) => {
        history.push(d);
        return Promise.resolve(d);
      }),
      updateMany: jest.fn(() => Promise.resolve({ modifiedCount: 5 })),
    };
    const youtube = {
      observe: jest.fn().mockResolvedValue({
        ok: true,
        data: {
          source: "youtube",
          externalAccountId: "UCabcdefghijklmnopqrstuv",
          observedHandle: "chan1",
          observedFollowersCount: 10,
          externalUrl: "u",
          rawPlatformUpdatedAt: null,
        },
      }),
    };
    const service = new SocialAccountObservationService(
      currentModel as any,
      historyModel as any,
      youtube as any,
      { observe: jest.fn(), connectedPlatforms: jest.fn() } as any,
    );
    return { service, currentModel, historyModel, history, youtube };
  };

  it("scheduled observations are recorded as 'system' and need no admin", async () => {
    const { service, history, youtube } = setup();
    await service.observeScheduled({
      profileType: "Influencer",
      profileId: "a",
      entry: yt(1),
    });
    expect(youtube.observe).toHaveBeenCalledWith("@chan1");
    expect(history[0]).toMatchObject({
      requestedByRole: "system",
      requestedById: "",
      status: "success",
    });
  });

  it("the admin entry point still refuses non-admins", async () => {
    const { service } = setup();
    await expect(
      service.observe(
        { role: "influencer" },
        { profileType: "Influencer", profileId: "a", entry: yt(1) },
      ),
    ).rejects.toThrow("Admin access only");
  });

  it("purges only YouTube counts older than 30 days, from current and history", async () => {
    const { service, currentModel, historyModel } = setup();
    const r = await service.purgeExpiredYoutubeStatistics(NOW);
    const filter = {
      source: "youtube",
      capturedAt: { $lt: daysAgo(30) },
      observedFollowersCount: { $ne: null },
    };
    const update = {
      $set: { observedFollowersCount: null, statisticsPurgedAt: NOW },
    };
    expect(currentModel.updateMany).toHaveBeenCalledWith(filter, update);
    expect(historyModel.updateMany).toHaveBeenCalledWith(filter, update, {
      retentionPurge: YOUTUBE_STATISTICS_PURGE_OPTION,
      timestamps: false,
    });
    expect(r).toEqual({ current: 2, history: 5, cutoff: daysAgo(30) });
  });
});

describe("Stage 3D-1a — history stays append-only except the retention purge", () => {
  // Own mongoose instance with buffering off: an allowed query fails fast
  // ("no connection") instead of waiting for a database.
  const m = new mongoose.Mongoose();
  m.set("bufferCommands", false);
  const conn = m.createConnection();
  const History = conn.model(
    "ObservationHistoryRetentionProbe",
    SocialAccountObservationHistorySchema,
  );
  afterAll(() => conn.close());
  const purgeUpdate = () => ({
    $set: { observedFollowersCount: null, statisticsPurgedAt: new Date() },
  });
  // Exactly what the service passes.
  const opts = {
    retentionPurge: YOUTUBE_STATISTICS_PURGE_OPTION,
    timestamps: false,
  } as any;

  it("recognises only the exact purge", () => {
    const q = (filter: any, update: any, o: any) =>
      History.updateMany(filter, update, o);
    expect(
      isYoutubeStatisticsPurge(
        q({ source: "youtube" }, purgeUpdate(), opts) as any,
      ),
    ).toBe(true);
    expect(
      isYoutubeStatisticsPurge(
        q({ source: "youtube" }, purgeUpdate(), {}) as any,
      ),
    ).toBe(false);
    expect(
      isYoutubeStatisticsPurge(
        q({ source: "instagram" }, purgeUpdate(), opts) as any,
      ),
    ).toBe(false);
    expect(isYoutubeStatisticsPurge(q({}, purgeUpdate(), opts) as any)).toBe(
      false,
    );
    expect(
      isYoutubeStatisticsPurge(
        q(
          { source: "youtube" },
          {
            $set: {
              observedFollowersCount: null,
              statisticsPurgedAt: new Date(),
              status: "x",
            },
          },
          opts,
        ) as any,
      ),
    ).toBe(false);
    expect(
      isYoutubeStatisticsPurge(
        q(
          { source: "youtube" },
          {
            $set: { observedFollowersCount: 5, statisticsPurgedAt: new Date() },
          },
          opts,
        ) as any,
      ),
    ).toBe(false);
    expect(
      isYoutubeStatisticsPurge(
        q(
          { source: "youtube" },
          {
            $set: {
              observedFollowersCount: null,
              statisticsPurgedAt: new Date(),
            },
            $unset: { observedHandle: 1 },
          },
          opts,
        ) as any,
      ),
    ).toBe(false);
  });

  it("the hook lets the exact purge through and refuses everything else", async () => {
    // Allowed: passes the hook, then fails only because the probe has no database.
    await expect(
      History.updateMany({ source: "youtube" }, purgeUpdate(), opts).exec(),
    ).rejects.not.toThrow("append-only");
    await expect(
      History.updateMany({ source: "youtube" }, purgeUpdate()).exec(),
    ).rejects.toThrow("append-only");
    // Without timestamps:false mongoose adds $setOnInsert → still refused.
    await expect(
      History.updateMany({ source: "youtube" }, purgeUpdate(), {
        retentionPurge: YOUTUBE_STATISTICS_PURGE_OPTION,
      } as any).exec(),
    ).rejects.toThrow("append-only");
    await expect(
      History.updateOne({ source: "youtube" }, purgeUpdate(), opts).exec(),
    ).rejects.toThrow("append-only");
    await expect(
      History.deleteMany({ source: "youtube" }, opts).exec(),
    ).rejects.toThrow("append-only");
  });
});

describe("Stage 3D-1a — scheduler", () => {
  const setup = (
    outcomes: Array<{ status: string; lastError: string | null }> = [],
  ) => {
    const profiles = [approved("a", [yt(1), yt(2), yt(3), ig(4)])];
    const collection = jest.fn((name: string) => ({
      find: jest.fn(() => ({
        toArray: () => Promise.resolve(name === "influencers" ? profiles : []),
      })),
    }));
    const chain = (v: any) => {
      const q: any = {
        select: () => q,
        sort: () => q,
        lean: () => Promise.resolve(v),
      };
      return q;
    };
    const currentModel = {
      find: jest.fn(() => chain([])),
      countDocuments: jest.fn(() => Promise.resolve(0)),
    };
    const historyModel = {
      find: jest.fn(() => chain([])),
      findOne: jest.fn(() => chain(null)),
    };
    let i = 0;
    const observations = {
      purgeExpiredYoutubeStatistics: jest.fn(() =>
        Promise.resolve({ current: 0, history: 0, cutoff: daysAgo(30) }),
      ),
      observeScheduled: jest.fn(() =>
        Promise.resolve({
          observation: outcomes[i++] ?? { status: "success", lastError: null },
        }),
      ),
    };
    const scheduler = new YoutubeObservationSchedulerService(
      { collection } as any,
      currentModel as any,
      historyModel as any,
      observations as any,
    );
    return { scheduler, observations, collection, currentModel, historyModel };
  };
  const withFlag = async (
    value: string | undefined,
    fn: () => Promise<void>,
  ) => {
    const before = process.env[SCHEDULE_ENV_FLAG];
    if (value === undefined) delete process.env[SCHEDULE_ENV_FLAG];
    else process.env[SCHEDULE_ENV_FLAG] = value;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env[SCHEDULE_ENV_FLAG];
      else process.env[SCHEDULE_ENV_FLAG] = before;
    }
  };

  it("switch off (default): retention still runs, nothing is observed", async () => {
    for (const v of [undefined, "", "false", "1", "TRUE "]) {
      await withFlag(v, async () => {
        const { scheduler, observations } = setup();
        const s = await scheduler.run(NOW);
        expect(s!.enabled).toBe(false);
        expect(s!.observation).toBeNull();
        expect(observations.purgeExpiredYoutubeStatistics).toHaveBeenCalledWith(
          NOW,
        );
        expect(observations.observeScheduled).not.toHaveBeenCalled();
      });
    }
  });

  it("switch on: observes every due YouTube account (never Instagram) after the purge", async () => {
    await withFlag("true", async () => {
      const { scheduler, observations } = setup();
      const s = await scheduler.run(NOW);
      expect(
        observations.observeScheduled.mock.calls.map(
          (c: any) => c[0].entry.socialAccountId,
        ),
      ).toEqual([YT(1), YT(2), YT(3)]);
      expect(
        observations.purgeExpiredYoutubeStatistics.mock.invocationCallOrder[0],
      ).toBeLessThan(observations.observeScheduled.mock.invocationCallOrder[0]);
      expect(s!.observation).toMatchObject({
        candidates: 3,
        attempted: 3,
        succeeded: 3,
        stoppedEarly: null,
      });
    });
  });

  it("stops the run on rate limiting; keeps going on other failures", async () => {
    await withFlag("true", async () => {
      const { scheduler, observations } = setup([
        { status: "failed", lastError: "external_account_not_found" },
        { status: "failed", lastError: "rate_limited" },
      ]);
      const s = await scheduler.run(NOW);
      expect(observations.observeScheduled).toHaveBeenCalledTimes(2);
      expect(s!.observation).toMatchObject({
        attempted: 2,
        succeeded: 0,
        failed: { external_account_not_found: 1, rate_limited: 1 },
        stoppedEarly: "rate_limited",
      });
    });
  });

  it("status is read-only: it plans but never observes or purges", async () => {
    await withFlag("true", async () => {
      const { scheduler, observations } = setup();
      const st = await scheduler.status(NOW);
      expect(st).toMatchObject({
        enabled: true,
        switch: SCHEDULE_ENV_FLAG,
        candidates: 3,
        dueNow: 3,
        paused: [],
      });
      expect(st.retention).toEqual({ maxAgeDays: 30, countsOlderThanLimit: 0 });
      expect(observations.observeScheduled).not.toHaveBeenCalled();
      expect(observations.purgeExpiredYoutubeStatistics).not.toHaveBeenCalled();
    });
  });

  it("profile reads are YouTube-only, non-deleted, and never load contact or payout fields", async () => {
    const { scheduler, collection } = setup();
    await scheduler.plan(NOW);
    for (const call of collection.mock.results) {
      const find = call.value.find as jest.Mock;
      const [filter, options] = find.mock.calls[0];
      expect(filter.isDeleted).toEqual({ $ne: true });
      expect(Object.keys(options.projection)).not.toEqual(
        expect.arrayContaining(["email"]),
      );
      for (const k of ["email", "phoneNumber", "password", "payout"])
        expect(options.projection[k]).toBeUndefined();
    }
  });
});
