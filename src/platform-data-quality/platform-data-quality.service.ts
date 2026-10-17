import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  PLATFORM_EVENT_COHORTS,
  cohortStart,
} from "../platform-events/platform-event-coverage";
import {
  buildDataQualityReport,
  MIN_SAMPLE_SIZE,
} from "./data-quality.analysis";
import { CollectedData, InviteTimeline } from "./data-quality.types";
import { kolkataWindows, WindowKey } from "./kolkata-windows";

/** Aggregation expression: 1 when `field` is null or absent. */
const isNull = (field: string) => ({ $eq: [{ $ifNull: [field, null] }, null] });
const isType = (eventType: string) => ({ $eq: ["$eventType", eventType] });
/** First (earliest) timestamp of one event type within a $group. */
const firstOf = (eventType: string) => ({
  $min: { $cond: [isType(eventType), "$timestamp", null] },
});
const lastOf = (eventType: string) => ({
  $max: { $cond: [isType(eventType), "$timestamp", null] },
});
const sourceOf = (eventType: string) => ({
  $max: { $cond: [isType(eventType), "$metadata.source", null] },
});

function idStr(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (typeof value === "string") return value;
  return null;
}

/** Both stored forms of an id — operational collections hold hex strings or ObjectIds. */
function idForms(ids: string[]): Array<string | Types.ObjectId> {
  return ids.flatMap((id) =>
    Types.ObjectId.isValid(id) ? [id, new Types.ObjectId(id)] : [id],
  );
}

/**
 * Stage 2A data-quality report. READ-ONLY: only find/countDocuments/aggregate,
 * never a write. PlatformEvent queries are $group aggregations (one row per
 * type / campaign / recipient / invite), so raw events are never loaded; the
 * operational lookups are $in queries by the ids the events reference, plus
 * full scans of campaigntransactions — acceptable at current scale.
 */
@Injectable()
export class PlatformDataQualityService {
  constructor(
    @InjectModel("PlatformEvent") private readonly eventModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly transactionModel: Model<any>,
    @InjectModel("Payment") private readonly paymentModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
  ) {}

  async getReport(now = new Date()) {
    return buildDataQualityReport(await this.collect(now));
  }

  async collect(now: Date): Promise<CollectedData> {
    const windows = kolkataWindows(now);
    const windowKeys = Object.keys(windows) as WindowKey[];
    const earliestWindow = new Date(
      Math.min(...windowKeys.map((k) => windows[k].from.getTime())),
    );

    const [
      typeSource,
      perType,
      byCampaign,
      recipients,
      perInvite,
      legacy,
      duplicates,
      windowRows,
      paymentStages,
      creatorSamples,
      ownerSamples,
    ] = await Promise.all([
      this.eventModel.aggregate([
        {
          $group: {
            _id: { t: "$eventType", s: "$metadata.source" },
            count: { $sum: 1 },
            first: { $min: "$timestamp" },
            last: { $max: "$timestamp" },
          },
        },
      ]),
      this.eventModel.aggregate([
        {
          $group: {
            _id: "$eventType",
            total: { $sum: 1 },
            missingCampaignId: {
              $sum: { $cond: [isNull("$campaignId"), 1, 0] },
            },
            missingBrandId: { $sum: { $cond: [isNull("$brandId"), 1, 0] } },
            missingInfluencerId: {
              $sum: { $cond: [isNull("$influencerId"), 1, 0] },
            },
            missingInviteId: { $sum: { $cond: [isNull("$inviteId"), 1, 0] } },
            missingRecipientRole: {
              $sum: { $cond: [isNull("$recipientRole"), 1, 0] },
            },
            missingUserId: { $sum: { $cond: [isNull("$userId"), 1, 0] } },
            actorDiffersFromSubject: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $not: [isNull("$userId")] },
                      { $not: [isNull("$influencerId")] },
                      { $ne: ["$userId", "$influencerId"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      this.eventModel.aggregate([
        {
          $group: {
            _id: {
              c: "$campaignId",
              b: "$brandId",
              t: "$eventType",
              o: "$metadata.ownerType",
              m: "$metadata.campaignMode",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { influencerId: { $ne: null } } },
        {
          $group: {
            _id: { i: "$influencerId", r: "$recipientRole" },
            count: { $sum: 1 },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { inviteId: { $ne: null } } },
        {
          $group: {
            _id: "$inviteId",
            campaignId: { $max: "$campaignId" },
            recipientRole: { $max: "$recipientRole" },
            invitedAt: firstOf("creator_invited"),
            invitedSource: sourceOf("creator_invited"),
            appliedAt: firstOf("creator_applied"),
            viewedAt: firstOf("invite_viewed"),
            acceptedAt: firstOf("invite_accepted"),
            declinedAt: firstOf("invite_declined"),
            counterSentAt: firstOf("counter_offer_sent"),
            workStartedAt: firstOf("work_started"),
            submittedAt: firstOf("content_submitted"),
            approvedAt: firstOf("content_approved"),
            rejectedAt: firstOf("content_rejected"),
            lastDisputedAt: lastOf("content_disputed"),
            withdrawnAt: firstOf("invite_withdrawn"),
            withdrawnSource: sourceOf("invite_withdrawn"),
            withdrawnReasonNull: {
              $max: {
                $cond: [
                  {
                    $and: [
                      isType("invite_withdrawn"),
                      isNull("$metadata.reason"),
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { "metadata.legacyIds": { $exists: true } } },
        {
          $project: {
            eventType: 1,
            campaignId: 1,
            legacy: { $objectToArray: "$metadata.legacyIds" },
          },
        },
        { $unwind: "$legacy" },
        {
          $group: {
            _id: {
              t: "$eventType",
              f: "$legacy.k",
              v: "$legacy.v",
              c: "$campaignId",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { dedupeKey: { $type: "string" } } },
        { $group: { _id: "$dedupeKey", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: "duplicates" },
      ]),
      this.eventModel.aggregate([
        { $match: { timestamp: { $gte: earliestWindow } } },
        {
          $group: {
            _id: "$eventType",
            ...Object.fromEntries(
              windowKeys.map((k) => [
                k,
                {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$timestamp", windows[k].from] },
                          { $lt: ["$timestamp", windows[k].to] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              ]),
            ),
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { eventType: "payment_completed" } },
        { $group: { _id: "$metadata.stage", count: { $sum: 1 } } },
      ]),
      this.eventModel.aggregate([
        {
          $match: { eventType: "creator_invited", influencerId: { $ne: null } },
        },
        {
          $group: {
            _id: { i: "$influencerId", r: "$recipientRole" },
            n: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: "$_id.r",
            total: { $sum: 1 },
            withMinSample: {
              $sum: { $cond: [{ $gte: ["$n", MIN_SAMPLE_SIZE] }, 1, 0] },
            },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { eventType: "creator_invited", brandId: { $ne: null } } },
        { $group: { _id: "$brandId", n: { $sum: 1 } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            withMinSample: {
              $sum: { $cond: [{ $gte: ["$n", MIN_SAMPLE_SIZE] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    // ── Operational lookups, by the ids the events reference ────────────────
    const campaignIds = [
      ...new Set(byCampaign.map((r: any) => idStr(r._id.c)).filter(Boolean)),
    ] as string[];
    const ownerIds = [
      ...new Set(byCampaign.map((r: any) => idStr(r._id.b)).filter(Boolean)),
    ] as string[];
    const inviteIds = perInvite
      .map((r: any) => idStr(r._id))
      .filter(Boolean) as string[];
    const recipientIds = (role: string) =>
      [
        ...new Set(
          recipients
            .filter((r: any) => r._id.r === role)
            .map((r: any) => idStr(r._id.i))
            .filter(Boolean),
        ),
      ] as string[];
    const legacyOwnerValues = [
      ...new Set(
        legacy
          .filter((r: any) => r._id.f === "brandId")
          .map((r: any) => String(r._id.v)),
      ),
    ];
    const stage1Start = cohortStart(PLATFORM_EVENT_COHORTS.stage1);

    const [
      campaignDocs,
      campaignsTotal,
      inviteDocs,
      invitesTotal,
      influencerDocs,
      photographerDocs,
      brandOwnerDocs,
      photographerOwnerDocs,
      legacyBrands,
      legacyPhotographers,
      openCampaigns,
      transactions,
      platformPayments,
    ] = await Promise.all([
      campaignIds.length
        ? this.campaignModel
            .find({ _id: { $in: campaignIds } })
            .select("brandId ownerType campaignMode")
            .lean()
        : [],
      this.campaignModel.countDocuments({}),
      inviteIds.length
        ? this.inviteModel
            .find({ _id: { $in: inviteIds } })
            .select("_id")
            .lean()
        : [],
      this.inviteModel.countDocuments({}),
      this.findIds(this.influencerModel, recipientIds("influencer")),
      this.findIds(this.photographerModel, recipientIds("photographer")),
      this.findIds(this.brandModel, ownerIds),
      this.findIds(this.photographerModel, ownerIds),
      legacyOwnerValues.length
        ? this.brandModel
            .find({
              $or: [
                { brandUsername: { $in: legacyOwnerValues } },
                { username: { $in: legacyOwnerValues } },
              ],
            })
            .select("brandUsername username")
            .lean()
        : [],
      legacyOwnerValues.length
        ? this.photographerModel
            .find({
              $or: [
                { username: { $in: legacyOwnerValues } },
                { photographerUsername: { $in: legacyOwnerValues } },
              ],
            })
            .select("username photographerUsername")
            .lean()
        : [],
      this.campaignModel
        .find({ campaignMode: "tier_filtered_open" })
        .select("_id")
        .lean(),
      this.transactionModel
        .find({})
        .select(
          "transactionType collectionStatus payoutStatus resolveOutcome agreedAmount payerTotal platformFee recipientPayout inviteId",
        )
        .lean(),
      this.paymentModel.aggregate([
        {
          $group: {
            _id: { p: "$purpose", g: "$gatewayProvider" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const openCampaignIds = (openCampaigns as any[])
      .map((c) => idStr(c._id))
      .filter(Boolean) as string[];
    const txInviteIds = [
      ...new Set(
        (transactions as any[]).map((t) => idStr(t.inviteId)).filter(Boolean),
      ),
    ] as string[];
    const [openCampaignInvitesBeforeStage1, paiseDocs] = await Promise.all([
      openCampaignIds.length
        ? this.inviteModel.countDocuments({
            campaignId: { $in: idForms(openCampaignIds) },
            createdAt: { $lt: stage1Start },
          })
        : 0,
      txInviteIds.length
        ? this.inviteModel
            .find({ _id: { $in: txInviteIds } })
            .select("agreedAmountPaise")
            .lean()
        : [],
    ]);

    const resolvableLegacyOwners = new Set<string>();
    for (const doc of [
      ...(legacyBrands as any[]),
      ...(legacyPhotographers as any[]),
    ]) {
      for (const key of ["brandUsername", "username", "photographerUsername"]) {
        if (
          typeof doc?.[key] === "string" &&
          legacyOwnerValues.includes(doc[key])
        ) {
          resolvableLegacyOwners.add(doc[key]);
        }
      }
    }

    const perInviteRows: InviteTimeline[] = perInvite.map((r: any) => ({
      inviteId: idStr(r._id) as string,
      campaignId: idStr(r.campaignId),
      recipientRole: r.recipientRole ?? null,
      invitedAt: r.invitedAt ?? null,
      invitedSource: r.invitedSource ?? null,
      appliedAt: r.appliedAt ?? null,
      viewedAt: r.viewedAt ?? null,
      acceptedAt: r.acceptedAt ?? null,
      declinedAt: r.declinedAt ?? null,
      counterSentAt: r.counterSentAt ?? null,
      workStartedAt: r.workStartedAt ?? null,
      submittedAt: r.submittedAt ?? null,
      approvedAt: r.approvedAt ?? null,
      rejectedAt: r.rejectedAt ?? null,
      lastDisputedAt: r.lastDisputedAt ?? null,
      withdrawnAt: r.withdrawnAt ?? null,
      withdrawnSource: r.withdrawnSource ?? null,
      withdrawnReasonNull: r.withdrawnReasonNull === 1,
    }));

    return {
      now,
      typeSource: typeSource.map((r: any) => ({
        eventType: r._id.t,
        source: r._id.s ?? null,
        count: r.count,
        first: r.first ?? null,
        last: r.last ?? null,
      })),
      perType: perType.map((r: any) => ({ eventType: r._id, ...r })),
      byCampaign: byCampaign.map((r: any) => ({
        campaignId: idStr(r._id.c),
        brandId: idStr(r._id.b),
        eventType: r._id.t,
        metaOwnerType: r._id.o ?? null,
        metaCampaignMode: r._id.m ?? null,
        count: r.count,
      })),
      recipients: recipients.map((r: any) => ({
        influencerId: idStr(r._id.i),
        recipientRole: r._id.r ?? null,
        count: r.count,
      })),
      perInvite: perInviteRows,
      legacy: legacy.map((r: any) => ({
        eventType: r._id.t,
        field: r._id.f,
        value: String(r._id.v),
        campaignId: idStr(r._id.c),
        count: r.count,
      })),
      duplicateDedupeKeys: duplicates[0]?.duplicates ?? 0,
      windowCounts: windowRows.map((r: any) => ({
        eventType: r._id,
        counts: Object.fromEntries(
          windowKeys.map((k) => [k, r[k] ?? 0]),
        ) as Record<WindowKey, number>,
      })),
      paymentStages: paymentStages.map((r: any) => ({
        stage: r._id ?? null,
        count: r.count,
      })),
      sampleSize: {
        creators: creatorSamples.map((r: any) => ({
          recipientRole: r._id ?? null,
          total: r.total,
          withMinSample: r.withMinSample,
        })),
        owners: {
          total: ownerSamples[0]?.total ?? 0,
          withMinSample: ownerSamples[0]?.withMinSample ?? 0,
        },
      },
      campaigns: new Map(
        (campaignDocs as any[]).map((c) => [
          idStr(c._id) as string,
          {
            brandId: idStr(c.brandId),
            ownerType: c.ownerType ?? null,
            campaignMode: c.campaignMode ?? null,
          },
        ]),
      ),
      existing: {
        invites: new Set(
          (inviteDocs as any[]).map((d) => idStr(d._id) as string),
        ),
        influencers: influencerDocs,
        photographers: photographerDocs,
        brandOwners: brandOwnerDocs,
        photographerOwners: photographerOwnerDocs,
      },
      resolvableLegacyOwners,
      operational: {
        campaignsTotal,
        campaignsWithEvents: (campaignDocs as any[]).length,
        invitesTotal,
        invitesWithEvents: (inviteDocs as any[]).length,
        openCampaignInvitesBeforeStage1,
      },
      transactions: (transactions as any[]).map((t) => ({
        transactionType: t.transactionType ?? null,
        collectionStatus: t.collectionStatus ?? null,
        payoutStatus: t.payoutStatus ?? null,
        resolveOutcome: t.resolveOutcome ?? null,
        agreedAmount: t.agreedAmount ?? null,
        payerTotal: t.payerTotal ?? null,
        platformFee: t.platformFee ?? null,
        recipientPayout: t.recipientPayout ?? null,
        inviteId: idStr(t.inviteId),
      })),
      invitePaise: new Map(
        (paiseDocs as any[]).map((d) => [
          idStr(d._id) as string,
          typeof d.agreedAmountPaise === "number" ? d.agreedAmountPaise : null,
        ]),
      ),
      platformPayments: platformPayments.map((r: any) => ({
        purpose: r._id.p ?? null,
        gateway: r._id.g ?? null,
        count: r.count,
      })),
    };
  }

  private async findIds(
    model: Model<any>,
    ids: string[],
  ): Promise<Set<string>> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return new Set();
    const docs: any[] = await model
      .find({ _id: { $in: valid } })
      .select("_id")
      .lean();
    return new Set(docs.map((d) => idStr(d._id) as string));
  }
}
