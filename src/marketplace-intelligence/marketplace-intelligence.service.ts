import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { PlatformMetricsService } from "../platform-metrics/platform-metrics.service";
import {
  MIN_SAMPLE_SIZE,
  ReadinessInput,
  ValueCount,
  buildReadinessReport,
} from "./readiness.analysis";

/**
 * Stage 3B-0 — Marketplace Intelligence Readiness (admin-only, READ-ONLY).
 *
 * Measures the existing data with read-only aggregations (find / count /
 * aggregate / distinct on the native collections) and hands the numbers to the
 * pure report builder. Never writes, never calls a platform API, never touches
 * search, ranking or eligibility. Field fill-rates for profiles reuse Stage 2B's
 * attribute coverage instead of re-implementing it.
 */
const NOT_DELETED = { isDeleted: { $ne: true } };
const NON_EMPTY = { $exists: true, $nin: ["", null] };
const SOCIAL_ACCOUNT_ID = /^[a-f0-9]{24}$/;

@Injectable()
export class MarketplaceIntelligenceService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly platformMetrics: PlatformMetricsService,
  ) {}

  async getReadinessReport(now = new Date()) {
    return buildReadinessReport(await this.collect(now));
  }

  async collect(now: Date): Promise<ReadinessInput> {
    const db = this.connection;
    const col = (name: string) => db.collection(name);
    const days = (n: number) => new Date(now.getTime() - n * 864e5);

    const [
      attributeCoverage,
      lastLogin,
      approvedProfiles,
      lastLogin30d,
      lastLogin90d,
      trendScores,
      socialAccounts,
      verifications,
      observations,
      campaignCoverage,
      campaignGroups,
      eventRows,
      inviteStatusRows,
      invitesPerCreatorRows,
      distinct,
      masters,
    ] = await Promise.all([
      this.platformMetrics.attributeCoverage(),
      col("influencers").countDocuments({
        ...NOT_DELETED,
        lastLoginAt: { $ne: null },
      }),
      col("influencers").countDocuments({
        ...NOT_DELETED,
        status: "accepted",
        $or: [
          { verificationStatus: "approved" },
          { verifiedByTrendStarz: true },
        ],
      }),
      col("influencers").countDocuments({
        ...NOT_DELETED,
        lastLoginAt: { $gte: days(30) },
      }),
      col("influencers").countDocuments({
        ...NOT_DELETED,
        lastLoginAt: { $gte: days(90) },
      }),
      col("collaboration_audits").countDocuments({
        isCurrent: true,
        userType: "Influencer",
      }),
      col("influencers")
        .aggregate<{ total: number; withId: number }>([
          { $match: NOT_DELETED },
          { $unwind: "$socialMedia" },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              withId: {
                $sum: {
                  $cond: [
                    {
                      $regexMatch: {
                        input: {
                          $ifNull: ["$socialMedia.socialAccountId", ""],
                        },
                        regex: SOCIAL_ACCOUNT_ID,
                      },
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray(),
      col("social_account_verifications")
        .aggregate<{ ownership: number; tier: number }>([
          { $match: { profileType: "Influencer" } },
          {
            $group: {
              _id: null,
              ownership: {
                $sum: {
                  $cond: [{ $eq: ["$ownership.status", "verified"] }, 1, 0],
                },
              },
              tier: {
                $sum: { $cond: [{ $eq: ["$tier.status", "verified"] }, 1, 0] },
              },
            },
          },
        ])
        .toArray(),
      col("social_account_observations").countDocuments({
        profileType: "Influencer",
        capturedAt: { $ne: null },
      }),
      this.campaignCoverage(),
      Promise.all(
        ["status", "campaignMode", "campaignType"].map((f) =>
          col("campaigns")
            .aggregate<{ _id: string | null; n: number }>([
              { $group: { _id: `$${f}`, n: { $sum: 1 } } },
            ])
            .toArray(),
        ),
      ),
      col("platform_events")
        .aggregate<{ _id: { t: string; s: string | null }; n: number }>([
          {
            $group: {
              _id: { t: "$eventType", s: "$metadata.source" },
              n: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      col("campaigninvites")
        .aggregate<{ _id: string | null; n: number }>([
          { $group: { _id: "$status", n: { $sum: 1 } } },
        ])
        .toArray(),
      col("campaigninvites")
        .aggregate<{ _id: unknown; n: number }>([
          { $match: { influencerId: { $ne: null } } },
          { $group: { _id: "$influencerId", n: { $sum: 1 } } },
        ])
        .toArray(),
      this.distinctValues(),
      this.masterLists(),
    ]);

    // Stage 2B coverage → { entity: { records, fields } }, plus this stage's extras.
    const coverage: ReadinessInput["coverage"] = {};
    for (const e of attributeCoverage.entities) {
      coverage[e.entity] = {
        records: e.records,
        fields: Object.fromEntries(e.fields.map((f) => [f.field, f.present])),
      };
    }
    const influencer = coverage.influencer ?? { records: 0, fields: {} };
    influencer.fields.lastLoginAt = lastLogin;
    influencer.fields.approvedProfiles = approvedProfiles;
    influencer.fields.trendScore = trendScores;
    coverage.influencer = influencer;
    const sa = socialAccounts[0] ?? { total: 0, withId: 0 };
    coverage.socialAccount = {
      records: sa.total,
      fields: {
        socialAccountId: sa.withId,
        ownershipVerified: verifications[0]?.ownership ?? 0,
        tierVerified: verifications[0]?.tier ?? 0,
        observed: observations,
      },
    };
    coverage.campaign = campaignCoverage;

    const toMap = (rows: Array<{ _id: string | null; n: number }>) =>
      Object.fromEntries(rows.map((r) => [String(r._id ?? "null"), r.n]));

    const events: ReadinessInput["events"] = {};
    for (const r of eventRows) {
      const e = (events[r._id.t] ??= { total: 0, live: 0, backfill: 0 });
      e.total += r.n;
      if (r._id.s === "live") e.live += r.n;
      else if (r._id.s === "backfill") e.backfill += r.n;
    }

    const perCreator = invitesPerCreatorRows
      .map((r) => r.n)
      .sort((a, b) => a - b);
    const median = perCreator.length
      ? perCreator.length % 2
        ? perCreator[(perCreator.length - 1) / 2]
        : (perCreator[perCreator.length / 2 - 1] +
            perCreator[perCreator.length / 2]) /
          2
      : 0;

    return {
      generatedAt: now,
      coverage,
      creatorActivity: {
        creators: influencer.records,
        hasLastLogin: lastLogin,
        lastLogin30d,
        lastLogin90d,
      },
      campaignVolume: {
        total: campaignCoverage.records,
        byStatus: toMap(campaignGroups[0]),
        byMode: toMap(campaignGroups[1]),
        byType: toMap(campaignGroups[2]),
      },
      events,
      inviteStatusCounts: toMap(inviteStatusRows),
      invitesPerCreator: {
        creators: perCreator.length,
        median,
        max: perCreator.length ? perCreator[perCreator.length - 1] : 0,
        atLeastMinSample: perCreator.filter((n) => n >= MIN_SAMPLE_SIZE).length,
      },
      distinct,
      masters,
    };
  }

  /** How many campaigns carry each brand-specifiable requirement. */
  private async campaignCoverage(): Promise<{
    records: number;
    fields: Record<string, number>;
  }> {
    const c = this.connection.collection("campaigns");
    const count = (q: Record<string, unknown>) => c.countDocuments(q);
    const [
      records,
      platforms,
      categories,
      deliverables,
      pricedDeliverables,
      minInfluencerTier,
      targetTiers,
      followerRange,
      targetState,
      budget,
      dates,
    ] = await Promise.all([
      count({}),
      count({ "platforms.0": { $exists: true } }),
      count({ "categories.0": { $exists: true } }),
      count({ "deliverables.0": { $exists: true } }),
      count({
        socialMedia: {
          $elemMatch: {
            contentTypes: { $elemMatch: { enabled: true, price: { $gt: 0 } } },
          },
        },
      }),
      count({ minInfluencerTier: NON_EMPTY }),
      count({ "targetTiers.0": { $exists: true } }),
      count({
        $or: [
          { minFollowerCount: { $gt: 0 } },
          { maxFollowerCount: { $gt: 0 } },
        ],
      }),
      count({ $or: [{ targetState: NON_EMPTY }, { venueState: NON_EMPTY }] }),
      count({
        $or: [
          { budgetMin: { $gt: 0 } },
          { budgetMax: { $gt: 0 } },
          { estimatedBudget: { $gt: 0 } },
          { pricePerInfluencer: { $gt: 0 } },
        ],
      }),
      count({
        $or: [
          { startDate: { $ne: null } },
          { timelineStart: { $ne: null } },
          { acceptanceDeadline: { $ne: null } },
        ],
      }),
    ]);
    return {
      records,
      fields: {
        platforms,
        categories,
        deliverables,
        pricedDeliverables,
        minInfluencerTier,
        targetTiers,
        followerRange,
        targetState,
        budget,
        dates,
      },
    };
  }

  /** Distinct stored spellings (value + count) for every field the normalization audit checks. */
  private async distinctValues(): Promise<Record<string, ValueCount[]>> {
    const group = async (
      collection: string,
      path: string,
      unwinds: string[],
      match: Record<string, unknown> = {},
    ) => {
      const rows = await this.connection
        .collection(collection)
        .aggregate<{ _id: unknown; n: number }>([
          { $match: match },
          ...unwinds.map((u) => ({ $unwind: u })),
          { $group: { _id: `$${path}`, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 200 },
        ])
        .toArray();
      return rows.map((r) => ({
        value:
          typeof r._id === "string" || typeof r._id === "number"
            ? String(r._id)
            : null,
        count: r.n,
      }));
    };
    const entries: Array<[string, Promise<ValueCount[]>]> = [
      [
        "creator.platform",
        group(
          "influencers",
          "socialMedia.platform",
          ["$socialMedia"],
          NOT_DELETED,
        ),
      ],
      [
        "creator.tier",
        group("influencers", "socialMedia.tier", ["$socialMedia"], NOT_DELETED),
      ],
      [
        "creator.contentType",
        group(
          "influencers",
          "socialMedia.contentTypes.name",
          ["$socialMedia", "$socialMedia.contentTypes"],
          NOT_DELETED,
        ),
      ],
      [
        "creator.categories",
        group("influencers", "categories", ["$categories"], NOT_DELETED),
      ],
      [
        "creator.languages",
        group("influencers", "languages", ["$languages"], NOT_DELETED),
      ],
      [
        "creator.state",
        group("influencers", "location.state", [], NOT_DELETED),
      ],
      [
        "creator.country",
        group("influencers", "location.country", [], NOT_DELETED),
      ],
      ["campaign.platforms", group("campaigns", "platforms", ["$platforms"])],
      [
        "campaign.minInfluencerTier",
        group("campaigns", "minInfluencerTier", [], {
          minInfluencerTier: NON_EMPTY,
        }),
      ],
      [
        "campaign.contentType",
        group("campaigns", "socialMedia.contentTypes.name", [
          "$socialMedia",
          "$socialMedia.contentTypes",
        ]),
      ],
      [
        "campaign.categories",
        group("campaigns", "categories", ["$categories"]),
      ],
      [
        "campaign.deliverables",
        group("campaigns", "deliverables", ["$deliverables"]),
      ],
      ["campaign.status", group("campaigns", "status", [])],
    ];
    const values = await Promise.all(entries.map(([, p]) => p));
    return Object.fromEntries(entries.map(([k], i) => [k, values[i]]));
  }

  /** Admin master lists the UI offers — the reference for "canonical". */
  private async masterLists(): Promise<ReadinessInput["masters"]> {
    const names = async (collection: string, field = "name") =>
      (await this.connection.collection(collection).distinct(field)).filter(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
    const [categories, languages, states, contentTypes] = await Promise.all([
      names("categories"),
      names("languages"),
      names("states"),
      names("socialmedias", "contentTypes.name"),
    ]);
    return { categories, languages, states, contentTypes };
  }
}
