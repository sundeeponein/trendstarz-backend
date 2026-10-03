import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  MetricsWindow,
  buildAttributeCoverage,
  buildCampaignMetrics,
  buildCreatorMetrics,
  buildOverview,
  buildOwnerMetrics,
  buildRelationships,
  buildTimeSeries,
  resolveWindow,
} from "./metrics.analysis";
import {
  CampaignRecord,
  InviteJourney,
  JourneyData,
  Step,
} from "./metrics.types";

// ── Aggregation expression helpers ──────────────────────────────────────────
const isType = (t: string) => ({ $eq: ["$eventType", t] });
const isStage = (stage: string) => ({
  $and: [isType("payment_completed"), { $eq: ["$metadata.stage", stage] }],
});
const firstWhen = (cond: any) => ({
  $min: { $cond: [cond, "$timestamp", null] },
});
const lastWhen = (cond: any) => ({
  $max: { $cond: [cond, "$timestamp", null] },
});
const valueWhen = (cond: any, field: string) => ({
  $max: { $cond: [cond, field, null] },
});

const arr = (f: string) => ({ $cond: [{ $isArray: f }, f, []] });
const nonEmptyArr = (f: string) => ({ $gt: [{ $size: arr(f) }, 0] });
const nonEmptyStr = (f: string) => ({
  $gt: [
    {
      $strLenCP: {
        $trim: {
          input: {
            $convert: { input: f, to: "string", onError: "", onNull: "" },
          },
        },
      },
    },
    0,
  ],
});
const posNum = (f: string) => ({
  $gt: [{ $convert: { input: f, to: "double", onError: 0, onNull: 0 } }, 0],
});
const notNull = (f: string) => ({ $ne: [{ $ifNull: [f, null] }, null] });
const isTrue = (f: string) => ({ $eq: [f, true] });
const anyIn = (f: string, as: string, cond: any) => ({
  $anyElementTrue: [{ $map: { input: arr(f), as, in: cond } }],
});
const pricedOption = (list: string, as: string) =>
  anyIn(list, as, {
    $and: [isTrue(`$$${as}.enabled`), posNum(`$$${as}.price`)],
  });

/** Matching-relevant attributes per entity (field names verified against profile.schemas.ts). */
const ATTRIBUTE_CHECKS: Record<string, Record<string, any>> = {
  influencer: {
    categories: nonEmptyArr("$categories"),
    influencerCategory: nonEmptyStr("$influencerCategory"),
    creatorTypes: nonEmptyArr("$creatorTypes"),
    languages: nonEmptyArr("$languages"),
    locationState: nonEmptyStr("$location.state"),
    locationDistrict: nonEmptyStr("$location.district"),
    gender: nonEmptyStr("$gender"),
    dateOfBirth: notNull("$dateOfBirth"),
    socialMediaAccounts: nonEmptyArr("$socialMedia"),
    socialHandle: anyIn("$socialMedia", "sm", nonEmptyStr("$$sm.handle")),
    socialTier: anyIn("$socialMedia", "sm", nonEmptyStr("$$sm.tier")),
    followersCount: anyIn("$socialMedia", "sm", posNum("$$sm.followersCount")),
    pricedContentTypes: anyIn(
      "$socialMedia",
      "sm",
      pricedOption("$$sm.contentTypes", "ct"),
    ),
    selfReportedEngagement: anyIn(
      "$socialMedia",
      "sm",
      posNum("$$sm.selfReportedStats.avgLikes"),
    ),
    collaborationAvailability: isTrue("$collaborationAvailability.enabled"),
    promotionalPrice: posNum("$promotionalPrice"),
    verifiedByTrendStarz: isTrue("$verifiedByTrendStarz"),
    emailVerified: isTrue("$isEmailVerified"),
    mobileVerified: isTrue("$isMobileVerified"),
  },
  photographer: {
    skills: nonEmptyArr("$skills"),
    pricing: pricedOption("$pricing", "p"),
    equipment: nonEmptyArr("$equipment"),
    portfolio: nonEmptyStr("$portfolio"),
    locationState: nonEmptyStr("$location.state"),
    locationDistrict: nonEmptyStr("$location.district"),
    socialMediaAccounts: nonEmptyArr("$socialMedia"),
    followersCount: anyIn("$socialMedia", "sm", posNum("$$sm.followersCount")),
    collaborationAvailability: isTrue("$collaborationAvailability.enabled"),
    verifiedByTrendStarz: isTrue("$verifiedByTrendStarz"),
    emailVerified: isTrue("$isEmailVerified"),
    mobileVerified: isTrue("$isMobileVerified"),
  },
  brand: {
    categories: nonEmptyArr("$categories"),
    languages: nonEmptyArr("$languages"),
    description: nonEmptyStr("$description"),
    locationState: nonEmptyStr("$location.state"),
    locationDistrict: nonEmptyStr("$location.district"),
    website: nonEmptyStr("$website"),
    companySize: nonEmptyStr("$companySize"),
    foundedYear: posNum("$foundedYear"),
    products: nonEmptyArr("$products"),
    socialMediaAccounts: nonEmptyArr("$socialMedia"),
    verifiedByTrendStarz: isTrue("$verifiedByTrendStarz"),
  },
  campaign: {
    description: nonEmptyStr("$description"),
    script: nonEmptyStr("$script"),
    categories: nonEmptyArr("$categories"),
    platforms: nonEmptyArr("$platforms"),
    pricedDeliverables: anyIn(
      "$socialMedia",
      "sm",
      pricedOption("$$sm.contentTypes", "ct"),
    ),
    deliverables: nonEmptyArr("$deliverables"),
    budgetOrPrice: {
      $or: [
        posNum("$budgetMin"),
        posNum("$budgetMax"),
        posNum("$pricePerInfluencer"),
      ],
    },
    targetState: nonEmptyStr("$targetState"),
    targetDistrict: nonEmptyStr("$targetDistrict"),
    targetCities: nonEmptyArr("$targetCities"),
    targetTier: {
      $or: [nonEmptyStr("$minInfluencerTier"), nonEmptyArr("$targetTiers")],
    },
    followerRange: {
      $or: [posNum("$minFollowerCount"), posNum("$maxFollowerCount")],
    },
    campaignType: nonEmptyStr("$campaignType"),
    campaignMode: nonEmptyStr("$campaignMode"),
    acceptanceDeadline: notNull("$acceptanceDeadline"),
    timeline: { $or: [notNull("$timelineStart"), notNull("$startDate")] },
    maxCreators: posNum("$maxInfluencers"),
    promotionUrl: nonEmptyStr("$promotionUrl"),
    hashtags: nonEmptyStr("$hashtags"),
  },
};

function idStr(v: unknown): string | null {
  if (v instanceof Types.ObjectId) return v.toHexString();
  return typeof v === "string" ? v : null;
}

function step(at: any, source: any): Step {
  return {
    at: at ?? null,
    // Unknown source stays null: it must never qualify for a live-only cohort.
    source: source === "live" || source === "backfill" ? source : null,
  };
}

/**
 * Stage 2B metrics. READ-ONLY (aggregate / find / countDocuments only).
 * platform_events is reduced in MongoDB to one row per invite and one per
 * campaign; everything else is computed from those rows, so raw events are
 * never loaded. At current scale (tens of invites) this is trivially cheap; it
 * stays linear in invites, not events — revisit (e.g. pre-aggregated snapshots)
 * only if invites reach the ~100k range.
 */
@Injectable()
export class PlatformMetricsService {
  constructor(
    @InjectModel("PlatformEvent") private readonly eventModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
  ) {}

  async overview(window: MetricsWindow, now = new Date()) {
    const w = resolveWindow(window, now);
    const [data, activity, activeCampaignsNow] = await Promise.all([
      this.loadJourneys(now),
      this.eventModel.aggregate([
        ...(w ? [{ $match: { timestamp: { $gte: w.from, $lt: w.to } } }] : []),
        {
          $group: {
            _id: { t: "$eventType", s: "$metadata.source" },
            count: { $sum: 1 },
          },
        },
      ]),
      this.campaignModel.countDocuments({ status: "active" }),
    ]);
    return buildOverview(
      data,
      window,
      activity.map((r: any) => ({
        eventType: r._id.t,
        source: r._id.s ?? null,
        count: r.count,
      })),
      activeCampaignsNow,
    );
  }

  async timeSeries(window: MetricsWindow, now = new Date()) {
    const w = resolveWindow(window, now);
    const rows = await this.eventModel.aggregate([
      ...(w ? [{ $match: { timestamp: { $gte: w.from, $lt: w.to } } }] : []),
      {
        $group: {
          _id: {
            b: {
              $dateToString: {
                format: window === "all" ? "%Y-%m" : "%Y-%m-%d",
                date: "$timestamp",
                timezone: "Asia/Kolkata",
              },
            },
            t: "$eventType",
            s: "$metadata.source",
          },
          count: { $sum: 1 },
        },
      },
    ]);
    return buildTimeSeries(
      window,
      now,
      rows.map((r: any) => ({
        bucket: r._id.b,
        eventType: r._id.t,
        source: r._id.s ?? null,
        count: r.count,
      })),
    );
  }

  async creators(
    window: MetricsWindow,
    opts: {
      role?: "influencer" | "photographer";
      limit: number;
      offset: number;
    },
    now = new Date(),
  ) {
    return buildCreatorMetrics(await this.loadJourneys(now), window, opts);
  }

  async owners(
    window: MetricsWindow,
    opts: {
      ownerType?: "brand" | "photographer";
      limit: number;
      offset: number;
    },
    now = new Date(),
  ) {
    return buildOwnerMetrics(await this.loadJourneys(now), window, opts);
  }

  async campaigns(
    window: MetricsWindow,
    opts: { limit: number; offset: number },
    now = new Date(),
  ) {
    return buildCampaignMetrics(await this.loadJourneys(now), window, opts);
  }

  async relationships(
    opts: {
      creatorId?: string;
      campaignId?: string;
      limit: number;
      offset: number;
    },
    now = new Date(),
  ) {
    return buildRelationships(await this.loadJourneys(now), opts);
  }

  async attributeCoverage() {
    const sources: Array<[string, string, Model<any>, any]> = [
      [
        "influencer",
        "influencers",
        this.influencerModel,
        { isDeleted: { $ne: true } },
      ],
      [
        "photographer",
        "photographers",
        this.photographerModel,
        { isDeleted: { $ne: true } },
      ],
      ["brand", "brands", this.brandModel, { isDeleted: { $ne: true } }],
      ["campaign", "campaigns", this.campaignModel, {}],
    ];
    const results = await Promise.all(
      sources.map(async ([entity, collection, model, match]) => {
        const checks = ATTRIBUTE_CHECKS[entity];
        const [row] = await model.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              ...Object.fromEntries(
                Object.entries(checks).map(([field, cond]) => [
                  field,
                  { $sum: { $cond: [cond, 1, 0] } },
                ]),
              ),
            },
          },
        ]);
        const fields = Object.fromEntries(
          Object.keys(checks).map((f) => [f, Number(row?.[f] || 0)]),
        );
        return { entity, collection, total: Number(row?.total || 0), fields };
      }),
    );
    return buildAttributeCoverage(results);
  }

  /** One row per invite + one per campaign, with each campaign's current state. */
  async loadJourneys(now: Date): Promise<JourneyData> {
    const [inviteRows, campaignRows] = await Promise.all([
      this.eventModel.aggregate([
        { $match: { inviteId: { $ne: null } } },
        {
          $group: {
            _id: "$inviteId",
            campaignId: { $max: "$campaignId" },
            ownerId: { $max: "$brandId" },
            creatorId: { $max: "$influencerId" },
            recipientRole: { $max: "$recipientRole" },
            platform: { $max: "$platform" },
            eventCampaignMode: valueWhen(
              { $in: ["$eventType", ["creator_invited", "creator_applied"]] },
              "$metadata.campaignMode",
            ),
            ...this.stepFields("invited", isType("creator_invited")),
            ...this.stepFields("applied", isType("creator_applied")),
            ...this.stepFields("viewed", isType("invite_viewed")),
            ...this.stepFields("counterSent", isType("counter_offer_sent")),
            ...this.stepFields("accepted", isType("invite_accepted")),
            ...this.stepFields("declined", isType("invite_declined")),
            ...this.stepFields("workStarted", isType("work_started")),
            ...this.stepFields("submitted", isType("content_submitted")),
            ...this.stepFields("approved", isType("content_approved")),
            ...this.stepFields("rejected", isType("content_rejected")),
            ...this.stepFields("firstDisputed", isType("content_disputed")),
            lastDisputedAt: lastWhen(isType("content_disputed")),
            ...this.stepFields("withdrawn", isType("invite_withdrawn")),
            withdrawnReason: valueWhen(
              isType("invite_withdrawn"),
              "$metadata.reason",
            ),
            ...this.stepFields("collection", isStage("collection")),
            ...this.stepFields("payout", isStage("payout")),
            collectionPaise: valueWhen(
              isStage("collection"),
              "$metadata.payerTotal",
            ),
            payoutPaise: valueWhen(
              isStage("payout"),
              "$metadata.recipientPayout",
            ),
          },
        },
      ]),
      this.eventModel.aggregate([
        {
          $match: {
            eventType: { $in: ["campaign_created", "campaign_completed"] },
            campaignId: { $ne: null },
          },
        },
        {
          $group: {
            _id: "$campaignId",
            ownerId: { $max: "$brandId" },
            ...this.stepFields("created", isType("campaign_created")),
            ...this.stepFields("completed", isType("campaign_completed")),
            completedBy: valueWhen(
              isType("campaign_completed"),
              "$metadata.completedBy",
            ),
            eventCampaignMode: valueWhen(
              isType("campaign_created"),
              "$metadata.campaignMode",
            ),
            eventCampaignType: valueWhen(
              isType("campaign_created"),
              "$metadata.campaignType",
            ),
            eventOwnerType: valueWhen(
              isType("campaign_created"),
              "$metadata.ownerType",
            ),
          },
        },
      ]),
    ]);

    const journeys: InviteJourney[] = inviteRows.map((r: any) => ({
      inviteId: idStr(r._id) as string,
      campaignId: idStr(r.campaignId),
      ownerId: idStr(r.ownerId),
      creatorId: idStr(r.creatorId),
      recipientRole: r.recipientRole ?? null,
      platform: r.platform ?? null,
      eventCampaignMode: r.eventCampaignMode ?? null,
      invited: step(r.invitedAt, r.invitedSource),
      applied: step(r.appliedAt, r.appliedSource),
      viewed: step(r.viewedAt, r.viewedSource),
      counterSent: step(r.counterSentAt, r.counterSentSource),
      accepted: step(r.acceptedAt, r.acceptedSource),
      declined: step(r.declinedAt, r.declinedSource),
      workStarted: step(r.workStartedAt, r.workStartedSource),
      submitted: step(r.submittedAt, r.submittedSource),
      approved: step(r.approvedAt, r.approvedSource),
      rejected: step(r.rejectedAt, r.rejectedSource),
      firstDisputed: step(r.firstDisputedAt, r.firstDisputedSource),
      lastDisputed: step(r.lastDisputedAt, r.firstDisputedSource),
      withdrawn: step(r.withdrawnAt, r.withdrawnSource),
      withdrawnReason: r.withdrawnReason ?? null,
      collection: step(r.collectionAt, r.collectionSource),
      payout: step(r.payoutAt, r.payoutSource),
      collectionPaise:
        typeof r.collectionPaise === "number" ? r.collectionPaise : null,
      payoutPaise: typeof r.payoutPaise === "number" ? r.payoutPaise : null,
    }));

    const records = new Map<string, CampaignRecord>();
    for (const r of campaignRows) {
      const id = idStr(r._id);
      if (!id) continue;
      records.set(id, {
        campaignId: id,
        ownerId: idStr(r.ownerId),
        created: step(r.createdAt, r.createdSource),
        completed: step(r.completedAt, r.completedSource),
        completedBy: r.completedBy ?? null,
        eventCampaignMode: r.eventCampaignMode ?? null,
        eventCampaignType: r.eventCampaignType ?? null,
        eventOwnerType: r.eventOwnerType ?? null,
        current: null,
      });
    }
    // Campaigns referenced only by invites still need a record (for current state).
    for (const j of journeys) {
      if (j.campaignId && !records.has(j.campaignId)) {
        records.set(j.campaignId, {
          campaignId: j.campaignId,
          ownerId: j.ownerId,
          created: step(null, null),
          completed: step(null, null),
          completedBy: null,
          eventCampaignMode: null,
          eventCampaignType: null,
          eventOwnerType: null,
          current: null,
        });
      }
    }

    const ids = [...records.keys()].filter((id) => Types.ObjectId.isValid(id));
    const current: any[] = ids.length
      ? await this.campaignModel
          .find({ _id: { $in: ids } })
          .select("campaignMode campaignType ownerType status")
          .lean()
      : [];
    for (const c of current) {
      const rec = records.get(idStr(c._id) as string);
      if (rec) {
        rec.current = {
          campaignMode: c.campaignMode ?? null,
          campaignType: c.campaignType ?? null,
          ownerType: c.ownerType ?? null,
          status: c.status ?? null,
        };
      }
    }

    return { now, journeys, campaigns: records };
  }

  private stepFields(name: string, cond: any) {
    return {
      [`${name}At`]: firstWhen(cond),
      [`${name}Source`]: valueWhen(cond, "$metadata.source"),
    };
  }
}
