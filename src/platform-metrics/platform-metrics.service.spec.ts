import { Types } from "mongoose";
import { PlatformMetricsService } from "./platform-metrics.service";

const oid = (n: number) => new Types.ObjectId(n.toString(16).padStart(24, "0"));
const WRITES = [
  "create",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "bulkWrite",
];

function model(aggregate: (p: any[]) => any[], find: any[] = [], count = 0) {
  const pipelines: any[][] = [];
  const m: any = {
    pipelines,
    aggregate: jest.fn((p: any[]) => {
      pipelines.push(p);
      return Promise.resolve(aggregate(p));
    }),
    find: jest.fn(() => {
      const q: any = {
        select: jest.fn(() => q),
        lean: jest.fn(() => Promise.resolve(find)),
      };
      return q;
    }),
    countDocuments: jest.fn(() => Promise.resolve(count)),
  };
  for (const w of WRITES) m[w] = jest.fn();
  return m;
}

const invitedAt = new Date("2026-10-01T10:00:00Z");

function eventAggregate(p: any[]) {
  const s = JSON.stringify(p);
  if (s.includes('"_id":"$inviteId"')) {
    return [
      {
        _id: oid(2),
        campaignId: oid(1),
        ownerId: oid(4),
        creatorId: oid(3),
        recipientRole: "influencer",
        eventCampaignMode: "invite_only",
        invitedAt,
        invitedSource: "live",
        acceptedAt: new Date("2026-10-01T12:00:00Z"),
        acceptedSource: undefined, // unknown source
      },
    ];
  }
  if (s.includes('"_id":"$campaignId"')) {
    return [
      {
        _id: oid(1),
        ownerId: oid(4),
        createdAt: invitedAt,
        createdSource: "live",
        eventOwnerType: "brand",
      },
    ];
  }
  return [];
}

describe("PlatformMetricsService", () => {
  let models: Record<string, any>;
  let service: PlatformMetricsService;

  beforeEach(() => {
    models = {
      event: model(eventAggregate),
      campaign: model(
        () => [{ _id: null, total: 2, description: 1 }],
        [{ _id: oid(1), campaignMode: "invite_only", status: "active" }],
        1,
      ),
      influencer: model(() => [
        { _id: null, total: 4, categories: 4, followersCount: 0 },
      ]),
      photographer: model(() => []),
      brand: model(() => [{ _id: null, total: 1 }]),
    };
    service = new PlatformMetricsService(
      models.event,
      models.campaign,
      models.influencer,
      models.photographer,
      models.brand,
    );
  });

  const noWrites = () => {
    for (const m of Object.values(models))
      for (const w of WRITES) expect(m[w]).not.toHaveBeenCalled();
  };

  it("builds every endpoint without calling a write method", async () => {
    const now = new Date("2026-10-02T06:00:00Z");
    await service.overview("all", now);
    await service.timeSeries("last7Days", now);
    await service.creators("all", { limit: 10, offset: 0 }, now);
    await service.owners("all", { limit: 10, offset: 0 }, now);
    await service.campaigns("all", { limit: 10, offset: 0 }, now);
    await service.relationships({ limit: 10, offset: 0 }, now);
    await service.attributeCoverage();
    noWrites();
  });

  it("takes the creator from influencerId and the owner from brandId — never the actor (userId)", async () => {
    await service.loadJourneys(new Date());
    const group = models.event.pipelines.find((p: any[]) =>
      JSON.stringify(p).includes('"_id":"$inviteId"'),
    )[1].$group;
    expect(group.creatorId).toEqual({ $max: "$influencerId" });
    expect(group.ownerId).toEqual({ $max: "$brandId" });
    expect(JSON.stringify(group)).not.toContain("$userId");
  });

  it("maps ObjectIds, attaches current campaign state, and never treats an unknown source as live", async () => {
    const d = await service.loadJourneys(new Date());
    const j = d.journeys[0];
    expect(j).toMatchObject({
      inviteId: oid(2).toHexString(),
      creatorId: oid(3).toHexString(),
      ownerId: oid(4).toHexString(),
    });
    expect(j.invited.source).toBe("live");
    expect(j.accepted).toEqual({
      at: new Date("2026-10-01T12:00:00Z"),
      source: null,
    });
    expect(d.campaigns.get(oid(1).toHexString())?.current).toMatchObject({
      campaignMode: "invite_only",
      status: "active",
    });
  });

  it("separates payment stages in the journey pipeline", async () => {
    await service.loadJourneys(new Date());
    const group = JSON.stringify(models.event.pipelines[0]);
    expect(group).toContain('"$metadata.stage","collection"');
    expect(group).toContain('"$metadata.stage","payout"');
  });

  it("buckets time series by Asia/Kolkata calendar days", async () => {
    await service.timeSeries("last7Days", new Date("2026-10-02T06:00:00Z"));
    const p = JSON.stringify(models.event.pipelines.at(-1));
    expect(p).toContain('"timezone":"Asia/Kolkata"');
    expect(p).toContain('"format":"%Y-%m-%d"');
  });

  it("measures attribute coverage on non-deleted profiles only", async () => {
    const r = await service.attributeCoverage();
    expect(models.influencer.pipelines[0][0]).toEqual({
      $match: { isDeleted: { $ne: true } },
    });
    const inf = r.entities.find((e) => e.entity === "influencer")!;
    expect(inf.records).toBe(4);
    expect(inf.fields.find((f) => f.field === "followersCount")).toMatchObject({
      present: 0,
      status: "missing",
    });
    expect(r.entities.find((e) => e.entity === "photographer")!.records).toBe(
      0,
    );
  });
});
