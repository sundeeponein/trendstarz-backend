import {
  PLATFORM_EVENT_COHORTS,
  PLATFORM_EVENT_COVERAGE,
  TrackingCohort,
  cohortStart,
  cohortStartOrNull,
} from "../platform-events/platform-event-coverage";
import { PLATFORM_EVENT_TYPES } from "../platform-events/platform-event-types";
import { CollectedData, InviteTimeline } from "./data-quality.types";
import { kolkataWindows } from "./kolkata-windows";

/**
 * Stage 2A: turns grouped, read-only query results into the data-quality /
 * data-availability report. Pure — no database access — so every rule here is
 * unit-tested with fixtures. Output carries ids and counts only (no emails,
 * phones, free text).
 */

export const MIN_SAMPLE_SIZE = 20;
const SAMPLE_CAP = 10;

/** Events scoped to one invite: they are expected to carry creator + invite refs. */
const INVITE_SCOPED_EVENTS = new Set([
  "creator_invited",
  "creator_applied",
  "invite_viewed",
  "invite_accepted",
  "invite_declined",
  "invite_withdrawn",
  "counter_offer_sent",
  "counter_offer_declined",
  "work_started",
  "content_submitted",
  "content_approved",
  "content_rejected",
  "content_disputed",
]);
const CAMPAIGN_LEVEL_EVENTS = new Set([
  "campaign_created",
  "campaign_completed",
]);

type StageStatus =
  | "all_time"
  | "all_time_partial"
  | "cohort_limited"
  | "unavailable";

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

function before(a: Date | null, b: Date | null): boolean {
  return !!a && !!b && new Date(a).getTime() < new Date(b).getTime();
}

function describeCohort(cohort: TrackingCohort) {
  return {
    startsAt: cohortStart(cohort).toISOString(),
    deployedAt: iso(cohort.deployedAt),
    observedFirstEventAt: iso(cohort.observedFirstEventAt),
    cohortConfidence: cohort.confidence,
    evidence: cohort.evidence,
  };
}

export function buildDataQualityReport(data: CollectedData) {
  const stage1Start = cohortStart(PLATFORM_EVENT_COHORTS.stage1);
  const stage15Start = cohortStart(PLATFORM_EVENT_COHORTS.stage15);

  // ── Coverage ──────────────────────────────────────────────────────────────
  const bySource: Record<string, number> = { live: 0, backfill: 0, unknown: 0 };
  const typeRows = new Map<
    string,
    {
      total: number;
      live: number;
      backfill: number;
      unknown: number;
      first: Date | null;
      last: Date | null;
    }
  >();
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const row of data.typeSource) {
    const source =
      row.source === "live" || row.source === "backfill"
        ? row.source
        : "unknown";
    bySource[source] += row.count;
    const t = typeRows.get(row.eventType) || {
      total: 0,
      live: 0,
      backfill: 0,
      unknown: 0,
      first: null,
      last: null,
    };
    t.total += row.count;
    t[source] += row.count;
    if (row.first && (!t.first || row.first < t.first)) t.first = row.first;
    if (row.last && (!t.last || row.last > t.last)) t.last = row.last;
    typeRows.set(row.eventType, t);
    if (row.first && (!earliest || row.first < earliest)) earliest = row.first;
    if (row.last && (!latest || row.last > latest)) latest = row.last;
  }
  const total = bySource.live + bySource.backfill + bySource.unknown;
  const backfillApplied = bySource.backfill > 0;

  const windows = kolkataWindows(data.now);

  // ── Event coverage matrix ─────────────────────────────────────────────────
  const eventCoverageMatrix = PLATFORM_EVENT_TYPES.map((eventType) => {
    const cov = PLATFORM_EVENT_COVERAGE[eventType];
    const cohort = cov.liveCohort
      ? PLATFORM_EVENT_COHORTS[cov.liveCohort]
      : null;
    const observed = typeRows.get(eventType);
    return {
      eventType,
      // null while the cohort is not yet deployed (e.g. a new event before release).
      liveAvailableFrom: cohort ? iso(cohortStartOrNull(cohort)) : null,
      cohortConfidence: cohort ? cohort.confidence : null,
      backfillable: cov.backfillable,
      backfillSource: cov.backfillSource,
      historicalLimitation: cov.historicalLimitation,
      observed: {
        live: observed?.live || 0,
        backfill: observed?.backfill || 0,
      },
    };
  });

  // ── Cohorts: which invites a cohort-limited step may count ────────────────
  const liveInvitedSince = (start: Date) =>
    data.perInvite.filter(
      (i) =>
        i.invitedSource === "live" &&
        i.invitedAt &&
        new Date(i.invitedAt) >= start,
    );
  const stage1Cohort = liveInvitedSince(stage1Start);
  const stage15Cohort = liveInvitedSince(stage15Start);
  const applicationsSinceStage1 = data.perInvite.filter(
    (i) => i.appliedAt && new Date(i.appliedAt) >= stage1Start,
  ).length;

  const cohortRules = [
    {
      steps: ["invite_viewed", "invite_declined"],
      rule: "Denominator = invites with a LIVE creator_invited event at or after the Stage 1 boundary.",
      boundary: stage1Start.toISOString(),
      cohortConfidence: PLATFORM_EVENT_COHORTS.stage1.confidence,
      eligibleInvites: stage1Cohort.length,
    },
    {
      steps: ["creator_applied"],
      rule: "Applications count only from creator_applied events at or after the Stage 1 boundary; older open-campaign invite rows are ambiguous (application vs owner invite) and excluded.",
      boundary: stage1Start.toISOString(),
      cohortConfidence: PLATFORM_EVENT_COHORTS.stage1.confidence,
      eligibleApplications: applicationsSinceStage1,
    },
    {
      steps: [
        "counter_offer_sent",
        "work_started",
        "content_disputed",
        "invite_withdrawn (reason / previousStatus)",
      ],
      rule: "Denominator = invites with a LIVE creator_invited event at or after the Stage 1.5 boundary.",
      boundary: stage15Start.toISOString(),
      cohortConfidence: PLATFORM_EVENT_COHORTS.stage15.confidence,
      eligibleInvites: stage15Cohort.length,
    },
    {
      steps: [
        "invite_accepted",
        "content_submitted",
        "content_approved",
        "content_rejected",
        "campaign_completed",
        "payment_completed",
        "campaign_created",
      ],
      rule: backfillApplied
        ? "Backfilled: all-time counts allowed, but report live vs backfill separately (backfill = derived confidence)."
        : "Backfill NOT applied: history starts at the Stage 1 boundary, so every 'all-time' figure is really 'since Stage 1'.",
      boundary: backfillApplied ? null : stage1Start.toISOString(),
      cohortConfidence: backfillApplied
        ? "derived_backfill"
        : PLATFORM_EVENT_COHORTS.stage1.confidence,
    },
  ];

  const invitesWithdrawn = data.perInvite.filter((i) => i.withdrawnAt);
  const withdrawals = {
    live: invitesWithdrawn.filter((i) => i.withdrawnSource === "live").length,
    backfilledClassified: invitesWithdrawn.filter(
      (i) => i.withdrawnSource === "backfill" && !i.withdrawnReasonNull,
    ).length,
    backfilledAmbiguous: invitesWithdrawn.filter(
      (i) => i.withdrawnSource === "backfill" && i.withdrawnReasonNull,
    ).length,
    note: "Ambiguous = historical withdrawal whose reason could not be classified (reason: null). Never assign it a reason.",
  };

  // ── Identity ──────────────────────────────────────────────────────────────
  const missingRefs = data.perType.map((row) => {
    const inviteScoped = INVITE_SCOPED_EVENTS.has(row.eventType);
    const campaignLevel = CAMPAIGN_LEVEL_EVENTS.has(row.eventType);
    return {
      eventType: row.eventType,
      total: row.total,
      missingCampaignId: row.missingCampaignId,
      missingOwnerId: row.missingBrandId,
      // Only counted where the event is expected to carry the reference.
      missingRecipientId: inviteScoped ? row.missingInfluencerId : 0,
      missingInviteId: inviteScoped ? row.missingInviteId : 0,
      missingRecipientRole: inviteScoped ? row.missingRecipientRole : 0,
      scope: inviteScoped
        ? "invite"
        : campaignLevel
          ? "campaign"
          : "transaction",
    };
  });

  const campaignIdsReferenced = new Set(
    data.byCampaign.map((r) => r.campaignId).filter((id): id is string => !!id),
  );
  const campaignsMissing = [...campaignIdsReferenced].filter(
    (id) => !data.campaigns.has(id),
  );
  const invitesMissing = data.perInvite
    .map((i) => i.inviteId)
    .filter((id) => !data.existing.invites.has(id));

  type RoleCheck = {
    referenced: number;
    missing: number;
    missingSample: string[];
  };
  const recipientByRole: { influencer: RoleCheck; photographer: RoleCheck } = {
    influencer: { referenced: 0, missing: 0, missingSample: [] },
    photographer: { referenced: 0, missing: 0, missingSample: [] },
  };
  let recipientsWithoutRole = 0;
  for (const r of data.recipients) {
    if (!r.influencerId) continue;
    const role =
      r.recipientRole === "photographer"
        ? "photographer"
        : r.recipientRole === "influencer"
          ? "influencer"
          : null;
    if (!role) {
      recipientsWithoutRole += 1;
      continue;
    }
    // influencerId is the invite RECIPIENT — look in the collection its role says.
    const pool =
      role === "photographer"
        ? data.existing.photographers
        : data.existing.influencers;
    recipientByRole[role].referenced += 1;
    if (!pool.has(r.influencerId)) {
      recipientByRole[role].missing += 1;
      if (recipientByRole[role].missingSample.length < SAMPLE_CAP)
        recipientByRole[role].missingSample.push(r.influencerId);
    }
  }

  // Owner type: event-carried metadata.ownerType, else the campaign's CURRENT ownerType.
  const ownerTypeSource = { event: 0, currentCampaignState: 0, unavailable: 0 };
  const ownerTypeDistribution: Record<string, number> = {
    brand: 0,
    photographer: 0,
    unavailable: 0,
  };
  const owners = new Map<string, string>();
  const campaignModeSource = {
    eventSourced: 0,
    currentStateFallback: 0,
    unavailable: 0,
  };
  for (const r of data.byCampaign) {
    const campaign = r.campaignId
      ? data.campaigns.get(r.campaignId)
      : undefined;
    let ownerType: string | null = null;
    if (r.metaOwnerType) {
      ownerType = r.metaOwnerType;
      ownerTypeSource.event += r.count;
    } else if (campaign?.ownerType) {
      ownerType = campaign.ownerType;
      ownerTypeSource.currentCampaignState += r.count;
    } else {
      ownerTypeSource.unavailable += r.count;
    }
    const ownerKey =
      ownerType === "photographer"
        ? "photographer"
        : ownerType
          ? "brand"
          : "unavailable";
    ownerTypeDistribution[ownerKey] += r.count;
    if (r.brandId && ownerType) owners.set(r.brandId, ownerKey);

    if (r.metaCampaignMode) campaignModeSource.eventSourced += r.count;
    else if (campaign?.campaignMode)
      campaignModeSource.currentStateFallback += r.count;
    else campaignModeSource.unavailable += r.count;
  }
  let ownersMissing = 0;
  const ownersMissingSample: string[] = [];
  for (const [ownerId, type] of owners) {
    const pool =
      type === "photographer"
        ? data.existing.photographerOwners
        : data.existing.brandOwners;
    if (!pool.has(ownerId)) {
      ownersMissing += 1;
      if (ownersMissingSample.length < SAMPLE_CAP)
        ownersMissingSample.push(ownerId);
    }
  }

  const recipientRoleDistribution: Record<string, number> = {
    influencer: 0,
    photographer: 0,
    none: 0,
  };
  for (const r of data.recipients) {
    const key =
      r.recipientRole === "photographer" || r.recipientRole === "influencer"
        ? r.recipientRole
        : "none";
    recipientRoleDistribution[key] += r.count;
  }

  // ── Legacy ids ────────────────────────────────────────────────────────────
  const legacyEvents = data.legacy.reduce((n, r) => n + r.count, 0);
  const legacyOwnerRows = data.legacy.filter((r) => r.field === "brandId");
  const legacy = {
    eventsWithNullOwnerId: data.perType.reduce(
      (n, r) => n + r.missingBrandId,
      0,
    ),
    eventsWithLegacyIds: legacyEvents,
    legacyOwnerRefs: {
      resolvableToCurrentOwner: legacyOwnerRows
        .filter((r) => data.resolvableLegacyOwners.has(r.value))
        .reduce((n, r) => n + r.count, 0),
      unresolvable: legacyOwnerRows
        .filter((r) => !data.resolvableLegacyOwners.has(r.value))
        .reduce((n, r) => n + r.count, 0),
    },
    eventTypesAffected: [...new Set(data.legacy.map((r) => r.eventType))],
    campaignsAffected: [
      ...new Set(data.legacy.map((r) => r.campaignId).filter(Boolean)),
    ].slice(0, SAMPLE_CAP),
    note: "Resolution is a read-only lookup for this report; nothing is written back. Unresolved legacy refs are NOT counted as valid owners.",
  };

  // ── Actor vs subject ──────────────────────────────────────────────────────
  const actorSemantics = data.perType
    .filter((r) => r.actorDiffersFromSubject > 0 || r.missingUserId > 0)
    .map((r) => ({
      eventType: r.eventType,
      actorDiffersFromCreator: r.actorDiffersFromSubject,
      systemOrUnknownActor: r.missingUserId,
    }));

  // ── Completion ────────────────────────────────────────────────────────────
  const approved = data.perInvite.filter((i) => i.approvedAt);
  const completion = {
    campaignLevelCompletions: typeRows.get("campaign_completed")?.total || 0,
    creatorLevelApprovals: approved.length,
    approvedThenDisputedOrRejected: approved.filter(
      (i) =>
        before(i.approvedAt, i.rejectedAt) ||
        before(i.approvedAt, i.lastDisputedAt),
    ).length,
    interpretation:
      "campaign_completed is campaign-level (no creator). A creator's collaboration counts as completed on content_approved, unless a later content_rejected/content_disputed for the same invite reverses it.",
  };

  // ── Open campaigns ────────────────────────────────────────────────────────
  const openCampaigns = {
    creatorAppliedEvents: typeRows.get("creator_applied")?.total || 0,
    creatorSelectedEvents: typeRows.get("creator_selected")?.total || 0,
    ambiguousHistoricalInvites:
      data.operational.openCampaignInvitesBeforeStage1,
    note: "On open campaigns both creator applications and owner invites are invite rows; before Stage 1 they cannot be told apart. The creator accepts their own application; there is no selection action, so creator_selected is unavailable.",
  };

  // ── Funnel stage safety ───────────────────────────────────────────────────
  const stageStatus = (
    eventType: string,
  ): { status: StageStatus; reason: string } => {
    const cov =
      PLATFORM_EVENT_COVERAGE[
        eventType as keyof typeof PLATFORM_EVENT_COVERAGE
      ];
    if (!cov || !cov.liveCohort)
      return {
        status: "unavailable",
        reason: cov?.historicalLimitation || "unknown event",
      };
    if (cov.backfillable === "no") {
      return {
        status: "cohort_limited",
        reason: `Not backfillable — count from the ${cov.liveCohort} boundary only.`,
      };
    }
    if (!backfillApplied) {
      return {
        status: "cohort_limited",
        reason:
          "Backfillable, but backfill has not been applied — history starts at Stage 1.",
      };
    }
    return cov.backfillable === "yes"
      ? { status: "all_time", reason: cov.backfillSource || "" }
      : { status: "all_time_partial", reason: cov.historicalLimitation };
  };
  const funnelStages = [
    "creator_invited",
    "creator_applied",
    "invite_viewed",
    "counter_offer_sent",
    "invite_accepted",
    "invite_declined",
    "invite_withdrawn",
    "work_started",
    "content_submitted",
    "content_disputed",
    "content_approved",
    "content_rejected",
    "creator_selected",
  ].map((eventType) => ({ eventType, ...stageStatus(eventType) }));

  // ── Timestamp ordering ────────────────────────────────────────────────────
  const anomaly = (pred: (i: InviteTimeline) => boolean) => {
    const hits = data.perInvite.filter(pred);
    return {
      count: hits.length,
      sampleInviteIds: hits.slice(0, SAMPLE_CAP).map((i) => i.inviteId),
    };
  };
  const timestampAnomalies = {
    acceptedBeforeCounterOfferSent: anomaly((i) =>
      before(i.acceptedAt, i.counterSentAt),
    ),
    acceptedBeforeInvited: anomaly((i) => before(i.acceptedAt, i.invitedAt)),
    submittedBeforeAccepted: anomaly((i) =>
      before(i.submittedAt, i.acceptedAt),
    ),
    approvedBeforeSubmitted: anomaly((i) =>
      before(i.approvedAt, i.submittedAt),
    ),
  };
  const knownIssues =
    timestampAnomalies.acceptedBeforeCounterOfferSent.count > 0
      ? [
          {
            id: "invite_accepted_counter_send_timestamp",
            affectedInviteIds:
              timestampAnomalies.acceptedBeforeCounterOfferSent.sampleInviteIds,
            count: timestampAnomalies.acceptedBeforeCounterOfferSent.count,
            description:
              "invite_accepted recorded before the counter-offer fix used invite.acceptedAt (the counter-SEND time) when the owner accepted a counter, so it precedes counter_offer_sent. Not rewritten (Stage 2A is read-only); exclude these invites from time-to-accept metrics.",
          },
        ]
      : [];

  // ── Money ─────────────────────────────────────────────────────────────────
  const checked = data.transactions.filter((t) => {
    const paise = t.inviteId ? data.invitePaise.get(t.inviteId) : null;
    return typeof paise === "number" && paise > 0;
  });
  const unitMismatches = checked.filter(
    (t) =>
      Number(t.agreedAmount) !== data.invitePaise.get(t.inviteId as string),
  );
  const unitStatus = unitMismatches.length === 0 ? "verified" : "inconsistent";
  const sum = (
    rows: typeof data.transactions,
    key: "payerTotal" | "platformFee" | "recipientPayout",
  ) => rows.reduce((n, t) => n + Number(t[key] || 0), 0);
  const verified = data.transactions.filter(
    (t) => t.collectionStatus === "verified",
  );
  const paid = data.transactions.filter((t) => t.payoutStatus === "paid");
  const byTxType: Record<string, number> = {};
  for (const t of data.transactions)
    byTxType[t.transactionType || "unknown"] =
      (byTxType[t.transactionType || "unknown"] || 0) + 1;
  const paymentEventStages: Record<string, number> = {};
  for (const r of data.paymentStages)
    paymentEventStages[r.stage || "unknown"] = r.count;

  const financial = {
    collaboration: {
      source: "campaigntransactions (current state) + payment_completed events",
      transactionCount: data.transactions.length,
      byTransactionType: byTxType,
      collectionsVerified: verified.length,
      payoutsPaid: paid.length,
      refundsToOwner: data.transactions.filter(
        (t) => t.resolveOutcome === "refund_to_brand",
      ).length,
      moneyUnit: {
        unit: "paise",
        status: unitStatus,
        evidence:
          "payments-payouts.service upsertCampaignPaymentTransactions sets agreedAmount = invite.agreedAmountPaise || campaign.pricePerInfluencer (schema: paise); payerTotal/platformFee/recipientPayout derive from it.",
        transactionsChecked: checked.length,
        mismatches: unitMismatches.length,
      },
      // Totals only when the unit is proven AND consistent with the data.
      totalsPaise:
        unitStatus === "verified"
          ? {
              collectedPayerTotal: sum(verified, "payerTotal"),
              platformFees: sum(verified, "platformFee"),
              paidOutToRecipients: sum(paid, "recipientPayout"),
            }
          : null,
    },
    paymentCompletedEvents: {
      collection: paymentEventStages.collection || 0,
      payout: paymentEventStages.payout || 0,
      unknownStage: paymentEventStages.unknown || 0,
      note: "collection = payer's payment verified; payout = recipient paid. Never combine them.",
    },
    platformPayments: {
      source:
        "payments collection — subscriptions, invite unlocks, collaboration-score purchases. NOT collaboration GMV.",
      rows: data.platformPayments,
      moneyUnit: {
        status: "mixed",
        evidence:
          "Razorpay rows are paise; manual UPI rows are rupees (payment.service getAdminSummary divides only Razorpay by 100). No totals are computed here.",
      },
    },
  };

  const existingSummaries = [
    {
      endpoint: "GET /api/payments-payouts/summary",
      measures:
        "Collaboration money: collected, fees, pending payouts, paid out, refunded, net balance (paise).",
      sources: ["campaigntransactions"],
      domain: "marketplace",
      differenceFromStage2:
        "Filters by transaction createdAt, not by when money moved; Stage 2 money-over-time must use payment_completed timestamps.",
    },
    {
      endpoint: "GET /api/payment/summary",
      measures:
        "Subscription revenue: received, pending, rejected, refunded (rupees; Razorpay paise converted).",
      sources: ["payments"],
      domain: "platform",
      differenceFromStage2:
        "Platform revenue, not marketplace activity; Stage 2 never mixes it with collaboration money.",
    },
    {
      endpoint: "GET /api/users/platform-stats",
      measures:
        "Current counts of public, approved influencers, photographers and brands (and verified subsets).",
      sources: ["influencers", "photographers", "brands"],
      domain: "platform (current state)",
      differenceFromStage2:
        "A snapshot of profiles, not activity over time; Stage 2 activity comes from platform_events.",
    },
  ];

  // ── Small samples ─────────────────────────────────────────────────────────
  const sampleSize = {
    minSampleSize: MIN_SAMPLE_SIZE,
    basis: "creator_invited events per entity",
    creators: data.sampleSize.creators.map((c) => ({
      recipientRole: c.recipientRole || "unknown",
      entities: c.total,
      withMinSample: c.withMinSample,
    })),
    campaignOwners: {
      entities: data.sampleSize.owners.total,
      withMinSample: data.sampleSize.owners.withMinSample,
    },
    rule: "Per-creator / per-owner rates below minSampleSize must be returned as insufficient_data; no rankings or recommendations.",
  };
  const entitiesWithSample =
    sampleSize.creators.reduce((n, c) => n + c.withMinSample, 0) +
    sampleSize.campaignOwners.withMinSample;

  // ── Readiness ─────────────────────────────────────────────────────────────
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (data.duplicateDedupeKeys > 0) {
    blockers.push(
      `${data.duplicateDedupeKeys} duplicate dedupeKey(s) — the unique index is not being enforced.`,
    );
  }
  for (const [key, cohort] of Object.entries(PLATFORM_EVENT_COHORTS)) {
    if (cohort.confidence === "not_yet_deployed") {
      warnings.push(
        `${key} is not live yet — set its deployedAt from the deployment log after release.`,
      );
    } else if (cohort.confidence !== "confirmed_deployment") {
      warnings.push(
        `${key} boundary is an observed first event (${iso(cohort.observedFirstEventAt)}), not a confirmed deployment time.`,
      );
    }
  }
  if (!backfillApplied)
    warnings.push(
      "Backfill not applied: all history starts at the Stage 1 boundary.",
    );
  if (knownIssues.length)
    warnings.push(
      `${knownIssues[0].count} invite(s) with the pre-fix invite_accepted timestamp — exclude from time-to-accept.`,
    );
  const otherAnomalies =
    timestampAnomalies.acceptedBeforeInvited.count +
    timestampAnomalies.submittedBeforeAccepted.count +
    timestampAnomalies.approvedBeforeSubmitted.count;
  if (otherAnomalies)
    warnings.push(
      `${otherAnomalies} invite(s) with out-of-order step timestamps.`,
    );
  if (campaignsMissing.length)
    warnings.push(
      `${campaignsMissing.length} campaign(s) referenced by events no longer exist.`,
    );
  if (invitesMissing.length)
    warnings.push(
      `${invitesMissing.length} invite(s) referenced by events no longer exist.`,
    );
  if (
    recipientByRole.influencer.missing + recipientByRole.photographer.missing
  ) {
    warnings.push(
      "Some event recipients no longer exist in their role's collection.",
    );
  }
  if (ownersMissing)
    warnings.push(
      `${ownersMissing} campaign owner(s) not found in their owner-type collection.`,
    );
  if (campaignModeSource.currentStateFallback) {
    warnings.push(
      `${campaignModeSource.currentStateFallback} event(s) get campaignMode from CURRENT campaign state, not history.`,
    );
  }
  if (ownerTypeSource.currentCampaignState) {
    warnings.push(
      `${ownerTypeSource.currentCampaignState} event(s) get owner type from current campaign state.`,
    );
  }
  if (legacy.legacyOwnerRefs.unresolvable)
    warnings.push(
      `${legacy.legacyOwnerRefs.unresolvable} event(s) with unresolvable legacy owner ids.`,
    );
  if (unitStatus !== "verified")
    warnings.push(
      "Collaboration money unit is inconsistent with invite data — monetary totals suppressed.",
    );
  if (entitiesWithSample === 0) {
    warnings.push(
      `No creator or owner has ${MIN_SAMPLE_SIZE}+ invites yet — every per-entity rate will be insufficient_data.`,
    );
  }

  const historyBasis = backfillApplied
    ? "all-time (live + derived backfill, reported separately)"
    : "since the Stage 1 boundary";
  const availableMetrics = [
    { metric: "campaign creation counts", basis: historyBasis },
    { metric: "campaign-level completion counts", basis: historyBasis },
    {
      metric: "invite counts (where creator_invited exists)",
      basis: historyBasis,
    },
    { metric: "creator activity, split by recipientRole", basis: historyBasis },
    {
      metric: "campaign-owner activity, split by owner type",
      basis: historyBasis,
    },
    {
      metric: "event-source (live vs backfill) breakdowns",
      basis: "all events",
    },
    {
      metric: "content submitted / approved / rejected counts",
      basis: historyBasis,
    },
    {
      metric: "payment_completed counts by stage (collection vs payout)",
      basis: historyBasis,
    },
    ...(unitStatus === "verified"
      ? [
          {
            metric: "collaboration money in paise",
            basis: "campaigntransactions, unit verified",
          },
        ]
      : []),
  ];
  const cohortLimitedMetrics = [
    {
      metric: "invite view rate",
      boundary: "stage1",
      eligibleInvites: stage1Cohort.length,
    },
    {
      metric: "decline rate",
      boundary: "stage1",
      eligibleInvites: stage1Cohort.length,
    },
    {
      metric: "application conversion (open campaigns)",
      boundary: "stage1",
      eligibleApplications: applicationsSinceStage1,
    },
    {
      metric: "counter-offer rate",
      boundary: "stage15",
      eligibleInvites: stage15Cohort.length,
    },
    {
      metric: "work-start rate",
      boundary: "stage15",
      eligibleInvites: stage15Cohort.length,
    },
    {
      metric: "dispute rate",
      boundary: "stage15",
      eligibleInvites: stage15Cohort.length,
    },
    {
      metric: "withdrawal reason breakdown",
      boundary: "stage15",
      eligibleInvites: stage15Cohort.length,
    },
    ...(backfillApplied
      ? []
      : [
          {
            metric: "time-to-accept / time-to-submit / time-to-approve",
            boundary: "stage1",
            eligibleInvites: stage1Cohort.length,
          },
        ]),
  ];
  const unavailableMetrics = [
    {
      metric: "creator selection (creator_selected)",
      reason: "No business action exists.",
    },
    {
      metric: "historical application vs owner-invite split",
      reason: "Indistinguishable before Stage 1.",
    },
    {
      metric: "campaign pause/resume history",
      reason: "Not recorded as events.",
    },
    {
      metric: "payment-side dispute history",
      reason: "raiseDispute/resolveDispute emit no events.",
    },
    {
      metric: "platform payment totals (payments collection)",
      reason: "Mixed units (rupees and paise).",
    },
    {
      metric: "creator/owner rankings or scores",
      reason: "Out of scope (descriptive only) and samples below minimum.",
    },
    ...(unitStatus === "verified"
      ? []
      : [
          {
            metric: "collaboration money totals",
            reason: "Money unit inconsistent.",
          },
        ]),
  ];

  const stage1Report = describeCohort(PLATFORM_EVENT_COHORTS.stage1);
  const stage15Report = describeCohort(PLATFORM_EVENT_COHORTS.stage15);

  return {
    generatedAt: data.now.toISOString(),
    timezone: "Asia/Kolkata",
    readOnly: true,
    cohorts: {
      stage1: stage1Report,
      stage15: stage15Report,
      cohortConfidence:
        stage1Report.cohortConfidence === "confirmed_deployment" &&
        stage15Report.cohortConfidence === "confirmed_deployment"
          ? "confirmed_deployment"
          : "observed_first_event",
    },
    backfill: {
      applied: backfillApplied,
      liveEvents: bySource.live,
      backfillEvents: bySource.backfill,
      note: backfillApplied
        ? "Backfilled events are derived (metadata.confidence: derived) — keep them separate from live."
        : "No backfilled events exist. Run the dry run (npm run backfill:platform-events) before deciding to apply.",
    },
    coverage: {
      totalEvents: total,
      bySource,
      earliest: iso(earliest),
      latest: iso(latest),
      byType: [...typeRows.entries()].map(([eventType, t]) => ({
        eventType,
        total: t.total,
        live: t.live,
        backfill: t.backfill,
        unknownSource: t.unknown,
        first: iso(t.first),
        last: iso(t.last),
      })),
      duplicateDedupeKeys: data.duplicateDedupeKeys,
      windows: {
        boundaries: Object.fromEntries(
          Object.entries(windows).map(([k, w]) => [
            k,
            { from: w.from.toISOString(), to: w.to.toISOString() },
          ]),
        ),
        countsByEventType: data.windowCounts,
      },
      operationalWithoutEvents: {
        campaigns:
          data.operational.campaignsTotal -
          data.operational.campaignsWithEvents,
        invites:
          data.operational.invitesTotal - data.operational.invitesWithEvents,
        note: "Records that exist today but have no event history (mostly pre-Stage-1 until backfill).",
      },
    },
    eventCoverageMatrix,
    cohortRules,
    withdrawals,
    identity: {
      missingReferencesByEventType: missingRefs,
      campaigns: {
        referenced: campaignIdsReferenced.size,
        missingFromCampaigns: campaignsMissing.length,
        missingSample: campaignsMissing.slice(0, SAMPLE_CAP),
      },
      invites: {
        referenced: data.perInvite.length,
        missingFromCampaignInvites: invitesMissing.length,
        missingSample: invitesMissing.slice(0, SAMPLE_CAP),
      },
      recipients: {
        ...recipientByRole,
        withoutRecipientRole: recipientsWithoutRole,
      },
      owners: {
        referenced: owners.size,
        missingFromOwnerCollection: ownersMissing,
        missingSample: ownersMissingSample,
      },
      ownerTypeDistribution,
      ownerTypeSource,
      recipientRoleDistribution,
    },
    legacyIds: legacy,
    actorSemantics: {
      perEventType: actorSemantics,
      rule: "userId is the ACTOR. Creator metrics key on influencerId (+recipientRole); owner metrics on brandId (+owner type).",
    },
    campaignMode: {
      ...campaignModeSource,
      rule: "Use metadata.campaignMode when present; otherwise the campaign's CURRENT mode, labelled campaignModeSource=current_campaign_state.",
    },
    completion,
    openCampaigns,
    funnelStages,
    timestampAnomalies,
    knownIssues,
    financial,
    existingSummaries,
    sampleSize,
    dataDictionary: DATA_DICTIONARY,
    stage2bReadiness: {
      stage2bReady: blockers.length === 0,
      blockers,
      warnings,
      availableMetrics,
      cohortLimitedMetrics,
      unavailableMetrics,
    },
  };
}

export const DATA_DICTIONARY = {
  actor:
    "userId + userRole — who performed the action (creator, owner, admin, or null/system).",
  campaignOwner:
    "brandId — the campaign's owner, a brand OR a photographer (metadata.ownerType, else the campaign's ownerType). Report as 'campaign owner', never assume brand.",
  creator:
    "influencerId + recipientRole — the invite recipient, an influencer OR a photographer. Look it up in the collection its recipientRole names.",
  recipient:
    "Same as creator: the person invited to / applying for a campaign.",
  campaignCompletion:
    "campaign_completed — campaign-level, no creator; one per campaign.",
  creatorCompletion:
    "content_approved for an invite, unless a later content_rejected/content_disputed on the same invite reverses it.",
  campaignMode:
    "metadata.campaignMode when the event carries it (historical); otherwise current campaign state, flagged as such.",
  moneyDomains:
    "Collaboration money = campaigntransactions + payment_completed (paise; metadata.stage collection vs payout). Platform payments = payments collection (mixed units). Never combined.",
  source:
    "metadata.source — live (recorded when it happened) or backfill (derived later from stored fields).",
};
