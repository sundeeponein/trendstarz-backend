import { Types } from "mongoose";
import { PlatformDataQualityService } from "./platform-data-quality.service";
import {
  PLATFORM_EVENT_COHORTS,
  cohortStart,
} from "../platform-events/platform-event-coverage";

const oid = (n: number) => new Types.ObjectId(n.toString(16).padStart(24, "0"));
const CAMPAIGN = oid(1);
const INVITE = oid(2);
const CREATOR = oid(3);
const OWNER = oid(4);

const WRITE_METHODS = [
  "create",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "findOneAndDelete",
  "findByIdAndDelete",
  "bulkWrite",
];

/** Chainable, awaitable query resolving to `value`; records the select() projection. */
function query(value: any, selects: string[]) {
  const q: any = {
    select: jest.fn((fields: string) => {
      selects.push(fields);
      return q;
    }),
    lean: jest.fn(() => q),
    then: (res: any, rej: any) => Promise.resolve(value).then(res, rej),
  };
  return q;
}

function model(
  opts: {
    find?: (filter: any) => any;
    aggregate?: (pipeline: any[]) => any;
    count?: (filter: any) => number;
  },
  selects: string[],
) {
  const m: any = {
    find: jest.fn((filter: any) =>
      query(opts.find ? opts.find(filter) : [], selects),
    ),
    aggregate: jest.fn((pipeline: any[]) =>
      Promise.resolve(opts.aggregate ? opts.aggregate(pipeline) : []),
    ),
    countDocuments: jest.fn((filter: any) =>
      Promise.resolve(opts.count ? opts.count(filter) : 0),
    ),
  };
  for (const w of WRITE_METHODS) m[w] = jest.fn();
  return m;
}

/** Answers each event aggregation by what its pipeline groups on. */
function eventAggregate(pipeline: any[]): any[] {
  const p = JSON.stringify(pipeline);
  const at = (iso: string) => new Date(iso);
  if (p.includes('"s":"$metadata.source"')) {
    return [
      {
        _id: { t: "creator_invited", s: "live" },
        count: 1,
        first: at("2026-10-01T10:00:00Z"),
        last: at("2026-10-01T10:00:00Z"),
      },
      {
        _id: { t: "invite_accepted", s: "live" },
        count: 1,
        first: at("2026-10-01T12:00:00Z"),
        last: at("2026-10-01T12:00:00Z"),
      },
    ];
  }
  if (p.includes("missingCampaignId")) {
    return [
      {
        _id: "invite_accepted",
        total: 1,
        missingCampaignId: 0,
        missingBrandId: 0,
        missingInfluencerId: 0,
        missingInviteId: 0,
        missingRecipientRole: 0,
        missingUserId: 0,
        actorDiffersFromSubject: 1,
      },
    ];
  }
  if (p.includes('"o":"$metadata.ownerType"')) {
    return [
      {
        _id: { c: CAMPAIGN, b: OWNER, t: "creator_invited", m: "invite_only" },
        count: 1,
      },
    ];
  }
  if (p.includes("invitedAt")) {
    return [
      {
        _id: INVITE,
        campaignId: CAMPAIGN,
        recipientRole: "influencer",
        invitedAt: at("2026-10-01T10:00:00Z"),
        invitedSource: "live",
        acceptedAt: at("2026-10-01T12:00:00Z"),
        withdrawnReasonNull: 0,
      },
    ];
  }
  if (p.includes("$objectToArray")) return [];
  if (p.includes("$count")) return [];
  if (p.includes('"today"')) return [];
  if (p.includes('"$metadata.stage"')) return [{ _id: "collection", count: 2 }];
  if (p.includes('"creator_invited"') && p.includes('"$brandId"'))
    return [{ _id: null, total: 1, withMinSample: 0 }];
  if (p.includes('"creator_invited"'))
    return [{ _id: "influencer", total: 1, withMinSample: 0 }];
  if (p.includes('"i":"$influencerId"'))
    return [{ _id: { i: CREATOR, r: "influencer" }, count: 2 }];
  return [];
}

describe("PlatformDataQualityService", () => {
  let selects: string[];
  let models: Record<string, any>;
  let service: PlatformDataQualityService;

  beforeEach(() => {
    selects = [];
    models = {
      event: model({ aggregate: eventAggregate }, selects),
      campaign: model(
        {
          find: (f) =>
            f?.campaignMode === "tier_filtered_open"
              ? [{ _id: oid(9) }]
              : [
                  {
                    _id: CAMPAIGN,
                    brandId: OWNER.toHexString(),
                    ownerType: "brand",
                    campaignMode: "invite_only",
                  },
                ],
          count: () => 5,
        },
        selects,
      ),
      invite: model(
        {
          find: (f) =>
            f?._id?.$in?.includes(INVITE.toHexString()) &&
            f?._id?.$in?.length === 1
              ? [{ _id: INVITE, agreedAmountPaise: 100000 }]
              : [],
          count: (f) => (f?.createdAt ? 3 : 50),
        },
        selects,
      ),
      transaction: model(
        {
          find: () => [
            {
              transactionType: "paid_collab",
              collectionStatus: "verified",
              payoutStatus: "paid",
              agreedAmount: 100000,
              payerTotal: 100000,
              platformFee: 0,
              recipientPayout: 100000,
              inviteId: INVITE,
            },
          ],
        },
        selects,
      ),
      payment: model(
        {
          aggregate: () => [
            { _id: { p: "subscription", g: "razorpay" }, count: 7 },
          ],
        },
        selects,
      ),
      influencer: model({ find: () => [{ _id: CREATOR }] }, selects),
      photographer: model({ find: () => [] }, selects),
      brand: model({ find: () => [{ _id: OWNER }] }, selects),
    };
    service = new PlatformDataQualityService(
      models.event,
      models.campaign,
      models.invite,
      models.transaction,
      models.payment,
      models.influencer,
      models.photographer,
      models.brand,
    );
  });

  it("builds the report without calling a single write method", async () => {
    const report = await service.getReport(new Date("2026-10-02T06:00:00Z"));
    expect(report.readOnly).toBe(true);
    for (const m of Object.values(models)) {
      for (const w of WRITE_METHODS) expect(m[w]).not.toHaveBeenCalled();
    }
  });

  it("maps ObjectIds to strings and checks existence in the right collections", async () => {
    const report = await service.getReport(new Date("2026-10-02T06:00:00Z"));
    expect(report.identity.campaigns).toMatchObject({
      referenced: 1,
      missingFromCampaigns: 0,
    });
    expect(report.identity.invites).toMatchObject({
      referenced: 1,
      missingFromCampaignInvites: 0,
    });
    expect(report.identity.recipients.influencer).toMatchObject({
      referenced: 1,
      missing: 0,
    });
    expect(report.identity.owners).toMatchObject({
      referenced: 1,
      missingFromOwnerCollection: 0,
    });
    expect(report.campaignMode).toMatchObject({ eventSourced: 1 });
    expect(report.financial.collaboration.moneyUnit).toMatchObject({
      status: "verified",
      transactionsChecked: 1,
    });
    expect(report.financial.paymentCompletedEvents.collection).toBe(2);
    expect(report.openCampaigns.ambiguousHistoricalInvites).toBe(3);
  });

  it("queries pre-Stage-1 open-campaign invites by both stored id forms", async () => {
    await service.getReport(new Date("2026-10-02T06:00:00Z"));
    const call = models.invite.countDocuments.mock.calls.find(
      ([f]: any[]) => f?.createdAt,
    );
    expect(call[0].createdAt).toEqual({
      $lt: cohortStart(PLATFORM_EVENT_COHORTS.stage1),
    });
    const forms = call[0].campaignId.$in;
    expect(forms).toContain(oid(9).toHexString());
    expect(forms.some((v: any) => v instanceof Types.ObjectId)).toBe(true);
  });

  it("never selects contact details or free-text fields from operational collections", async () => {
    await service.getReport(new Date("2026-10-02T06:00:00Z"));
    expect(selects.length).toBeGreaterThan(0);
    for (const fields of selects) {
      expect(fields).not.toMatch(
        /email|phone|password|message|reason|token|note/i,
      );
    }
  });
});
