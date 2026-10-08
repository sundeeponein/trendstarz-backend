import { PhotographersService } from "../photographers/photographers.service";
import { UsersService } from "../users/users.service";
import {
  __resetProfileTrafficIndexFlag,
  istDayKey,
  profileTrafficForLastDays,
  recordDailyProfileTraffic,
} from "./profile-traffic-daily.util";

const fakeCollection = (rows: any[] = []) => ({
  updateOne: jest.fn().mockResolvedValue({}),
  createIndex: jest.fn().mockResolvedValue("ok"),
  aggregate: jest
    .fn()
    .mockReturnValue({ toArray: () => Promise.resolve(rows) }),
});

describe("profile traffic daily history", () => {
  beforeEach(() => __resetProfileTrafficIndexFlag());

  it("days are India calendar days (UTC 18:29 is still the same day, 18:30 is the next)", () => {
    expect(istDayKey(new Date("2026-10-06T18:29:59.999Z"))).toBe("2026-10-06");
    expect(istDayKey(new Date("2026-10-06T18:30:00.000Z"))).toBe("2026-10-07");
  });

  it("adds one impression or click to the day's row (upsert), ensuring the unique index once", async () => {
    const c = fakeCollection();
    const now = new Date("2026-10-06T10:00:00Z");
    await recordDailyProfileTraffic(c, "Photographer", "p1", "impression", now);
    await recordDailyProfileTraffic(c, "Photographer", "p1", "click", now);
    expect(c.createIndex).toHaveBeenCalledTimes(1);
    expect(c.createIndex.mock.calls[0][1]).toEqual(
      expect.objectContaining({ unique: true }),
    );
    expect(c.updateOne.mock.calls[0]).toEqual([
      { profileType: "Photographer", profileId: "p1", day: "2026-10-06" },
      { $inc: { impressions: 1 }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    ]);
    expect(c.updateOne.mock.calls[1][1].$inc).toEqual({ clicks: 1 });
  });

  it("ignores a missing profile id", async () => {
    const c = fakeCollection();
    await recordDailyProfileTraffic(c, "Brand", "", "click");
    expect(c.updateOne).not.toHaveBeenCalled();
  });

  it("last N days: today plus the previous N-1 India days, summed", async () => {
    const c = fakeCollection([{ impressions: 12, clicks: 4 }]);
    const r = await profileTrafficForLastDays(
      c,
      "Influencer",
      "i1",
      30,
      new Date("2026-10-06T10:00:00Z"),
    );
    expect(r).toEqual({ impressions: 12, clicks: 4 });
    expect(c.aggregate.mock.calls[0][0][0]).toEqual({
      $match: {
        profileType: "Influencer",
        profileId: "i1",
        day: { $gte: "2026-09-07" },
      },
    });
    expect(
      await profileTrafficForLastDays(
        fakeCollection([]),
        "Influencer",
        "i1",
        30,
      ),
    ).toEqual({ impressions: 0, clicks: 0 });
  });
});

describe("profile traffic tracking per role (totals + daily history)", () => {
  const lean = (v: any) => ({ lean: () => Promise.resolve(v) });

  it("photographer view: updates the totals and records the day", async () => {
    const daily = fakeCollection();
    const service: any = Object.create(PhotographersService.prototype);
    service.photographerModel = {
      findOneAndUpdate: jest.fn().mockReturnValue(lean({ _id: "ph1" })),
      db: { collection: () => daily },
    };
    expect(await service.trackPhotographerProfileImpression("lens")).toEqual({
      tracked: true,
    });
    const [filter, update] =
      service.photographerModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ username: "lens", isDeleted: { $ne: true } });
    expect(update.$inc).toEqual({ "profileTraffic.impressions": 1 });
    await new Promise((r) => setImmediate(r));
    expect(daily.updateOne.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        profileType: "Photographer",
        profileId: "ph1",
      }),
    );
  });

  it("photographer click on an unknown username: nothing recorded", async () => {
    const daily = fakeCollection();
    const service: any = Object.create(PhotographersService.prototype);
    service.photographerModel = {
      findOneAndUpdate: jest.fn().mockReturnValue(lean(null)),
      db: { collection: () => daily },
    };
    expect(await service.trackPhotographerProfileClick("nobody")).toEqual({
      tracked: false,
    });
    expect(daily.updateOne).not.toHaveBeenCalled();
  });

  it("influencer and brand: totals as before, plus the day's row", async () => {
    const daily = fakeCollection();
    const service: any = Object.create(UsersService.prototype);
    service.influencerModel = {
      findOneAndUpdate: jest.fn().mockReturnValue(lean({ _id: "inf1" })),
      db: { collection: () => daily },
    };
    service.brandModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    service.findBrandByNameOrSlug = jest.fn().mockResolvedValue({ _id: "b1" });

    expect(await service.trackInfluencerProfileClick("asha")).toEqual({
      tracked: true,
    });
    expect(
      service.influencerModel.findOneAndUpdate.mock.calls[0][1].$inc,
    ).toEqual({
      "profileTraffic.clicks": 1,
    });
    expect(await service.trackBrandProfileImpression("acme")).toEqual({
      tracked: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(
      daily.updateOne.mock.calls.map((c: any[]) => [
        c[0].profileType,
        c[0].profileId,
        Object.keys(c[1].$inc)[0],
      ]),
    ).toEqual([
      ["Influencer", "inf1", "clicks"],
      ["Brand", "b1", "impressions"],
    ]);
  });

  it("a history failure never breaks tracking", async () => {
    const broken = {
      ...fakeCollection(),
      updateOne: jest.fn().mockRejectedValue(new Error("db down")),
    };
    const service: any = Object.create(UsersService.prototype);
    service.influencerModel = {
      findOneAndUpdate: jest.fn().mockReturnValue(lean({ _id: "inf1" })),
      db: { collection: () => broken },
    };
    await expect(
      service.trackInfluencerProfileImpression("asha"),
    ).resolves.toEqual({ tracked: true });
    await new Promise((r) => setImmediate(r));
  });
});
