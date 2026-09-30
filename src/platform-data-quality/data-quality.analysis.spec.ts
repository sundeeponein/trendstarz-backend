import {
  buildDataQualityReport,
  MIN_SAMPLE_SIZE,
} from "./data-quality.analysis";
import { CollectedData, InviteTimeline } from "./data-quality.types";
import {
  PLATFORM_EVENT_COHORTS,
  PLATFORM_EVENT_COVERAGE,
  cohortStart,
} from "../platform-events/platform-event-coverage";
import { PLATFORM_EVENT_TYPES } from "../platform-events/platform-event-types";

const NOW = new Date("2026-10-15T06:00:00.000Z"); // 11:30 IST
const STAGE1 = cohortStart(PLATFORM_EVENT_COHORTS.stage1);
const STAGE15 = cohortStart(PLATFORM_EVENT_COHORTS.stage15);
const after = (base: Date, hours: number) =>
  new Date(base.getTime() + hours * 3600_000);

function invite(overrides: Partial<InviteTimeline>): InviteTimeline {
  return {
    inviteId: "i0",
    campaignId: "c1",
    recipientRole: "influencer",
    invitedAt: null,
    invitedSource: null,
    appliedAt: null,
    viewedAt: null,
    acceptedAt: null,
    declinedAt: null,
    counterSentAt: null,
    workStartedAt: null,
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    lastDisputedAt: null,
    withdrawnAt: null,
    withdrawnReasonNull: false,
    withdrawnSource: null,
    ...overrides,
  };
}

function data(overrides: Partial<CollectedData> = {}): CollectedData {
  return {
    now: NOW,
    typeSource: [],
    perType: [],
    byCampaign: [],
    recipients: [],
    perInvite: [],
    legacy: [],
    duplicateDedupeKeys: 0,
    windowCounts: [],
    paymentStages: [],
    sampleSize: { creators: [], owners: { total: 0, withMinSample: 0 } },
    campaigns: new Map(),
    existing: {
      invites: new Set(),
      influencers: new Set(),
      photographers: new Set(),
      brandOwners: new Set(),
      photographerOwners: new Set(),
    },
    resolvableLegacyOwners: new Set(),
    operational: {
      campaignsTotal: 0,
      campaignsWithEvents: 0,
      invitesTotal: 0,
      invitesWithEvents: 0,
      openCampaignInvitesBeforeStage1: 0,
    },
    transactions: [],
    invitePaise: new Map(),
    platformPayments: [],
    ...overrides,
  };
}

const perTypeRow = (
  eventType: string,
  fields: Partial<CollectedData["perType"][number]> = {},
) => ({
  eventType,
  total: 1,
  missingCampaignId: 0,
  missingBrandId: 0,
  missingInfluencerId: 0,
  missingInviteId: 0,
  missingRecipientRole: 0,
  missingUserId: 0,
  actorDiffersFromSubject: 0,
  ...fields,
});

describe("Stage 2A data-quality analysis", () => {
  describe("cohort boundaries", () => {
    it("are labelled as observed first events, never as deployments", () => {
      const r = buildDataQualityReport(data());
      expect(r.cohorts.cohortConfidence).toBe("observed_first_event");
      expect(r.cohorts.stage1).toMatchObject({
        startsAt: "2026-09-29T16:58:00.000Z",
        deployedAt: null,
        cohortConfidence: "observed_first_event",
      });
      expect(r.cohorts.stage15.startsAt).toBe("2026-09-30T04:11:00.000Z");
      expect(r.stage2bReadiness.warnings.join(" ")).toMatch(
        /not a confirmed deployment time/,
      );
    });

    it("prefers a confirmed deployedAt when one is set", () => {
      const deployed = new Date("2026-09-29T16:30:00Z");
      expect(
        cohortStart({ ...PLATFORM_EVENT_COHORTS.stage1, deployedAt: deployed }),
      ).toBe(deployed);
    });

    it("has a coverage entry for every event type, with creator_selected unavailable", () => {
      for (const t of PLATFORM_EVENT_TYPES)
        expect(PLATFORM_EVENT_COVERAGE[t]).toBeDefined();
      const r = buildDataQualityReport(data());
      expect(r.eventCoverageMatrix.map((m) => m.eventType)).toEqual([
        ...PLATFORM_EVENT_TYPES,
      ]);
      expect(
        r.eventCoverageMatrix.find((m) => m.eventType === "creator_selected"),
      ).toMatchObject({
        liveAvailableFrom: null,
        backfillable: "no",
      });
      expect(
        r.funnelStages.find((s) => s.eventType === "creator_selected")?.status,
      ).toBe("unavailable");
    });

    it("excludes pre-Stage-1 and backfilled invites from cohort-limited funnels", () => {
      const r = buildDataQualityReport(
        data({
          perInvite: [
            invite({
              inviteId: "old",
              invitedAt: after(STAGE1, -24),
              invitedSource: "live",
            }),
            invite({
              inviteId: "bf",
              invitedAt: after(STAGE1, 1),
              invitedSource: "backfill",
            }),
            invite({
              inviteId: "s1",
              invitedAt: after(STAGE1, 2),
              invitedSource: "live",
            }),
            invite({
              inviteId: "s15",
              invitedAt: after(STAGE15, 2),
              invitedSource: "live",
            }),
          ],
        }),
      );
      const stage1Rule = r.cohortRules.find((c) =>
        c.steps.includes("invite_viewed"),
      );
      const stage15Rule = r.cohortRules.find((c) =>
        c.steps.includes("work_started"),
      );
      expect(stage1Rule?.eligibleInvites).toBe(2); // s1 + s15
      expect(stage15Rule?.eligibleInvites).toBe(1); // s15 only
      expect(stage15Rule?.boundary).toBe(STAGE15.toISOString());
    });

    it("marks non-backfillable steps cohort-limited, and backfillable ones all-time only after backfill", () => {
      const before = buildDataQualityReport(data());
      const stage = (r: any, t: string) =>
        r.funnelStages.find((s: any) => s.eventType === t).status;
      expect(stage(before, "invite_viewed")).toBe("cohort_limited");
      expect(stage(before, "invite_accepted")).toBe("cohort_limited");

      const afterBackfill = buildDataQualityReport(
        data({
          typeSource: [
            {
              eventType: "invite_accepted",
              source: "backfill",
              count: 5,
              first: null,
              last: null,
            },
          ],
        }),
      );
      expect(afterBackfill.backfill.applied).toBe(true);
      expect(stage(afterBackfill, "invite_accepted")).toBe("all_time");
      expect(stage(afterBackfill, "creator_invited")).toBe("all_time_partial");
      expect(stage(afterBackfill, "invite_viewed")).toBe("cohort_limited");
    });

    it("separates live, classified-backfill and ambiguous-backfill withdrawals", () => {
      const r = buildDataQualityReport(
        data({
          perInvite: [
            invite({
              inviteId: "a",
              withdrawnAt: NOW,
              withdrawnSource: "live",
            }),
            invite({
              inviteId: "b",
              withdrawnAt: NOW,
              withdrawnSource: "backfill",
            }),
            invite({
              inviteId: "c",
              withdrawnAt: NOW,
              withdrawnSource: "backfill",
              withdrawnReasonNull: true,
            }),
          ],
        }),
      );
      expect(r.withdrawals).toMatchObject({
        live: 1,
        backfilledClassified: 1,
        backfilledAmbiguous: 1,
      });
    });
  });

  describe("coverage", () => {
    it("counts events by type and source with earliest/latest", () => {
      const r = buildDataQualityReport(
        data({
          typeSource: [
            {
              eventType: "creator_invited",
              source: "live",
              count: 3,
              first: after(STAGE1, 1),
              last: after(STAGE1, 9),
            },
            {
              eventType: "creator_invited",
              source: "backfill",
              count: 7,
              first: new Date("2026-03-01T00:00:00Z"),
              last: after(STAGE1, -5),
            },
            {
              eventType: "campaign_created",
              source: null,
              count: 1,
              first: after(STAGE1, 2),
              last: after(STAGE1, 2),
            },
          ],
        }),
      );
      expect(r.coverage.totalEvents).toBe(11);
      expect(r.coverage.bySource).toEqual({ live: 3, backfill: 7, unknown: 1 });
      expect(r.coverage.earliest).toBe("2026-03-01T00:00:00.000Z");
      expect(r.coverage.latest).toBe(after(STAGE1, 9).toISOString());
      expect(
        r.coverage.byType.find((t) => t.eventType === "creator_invited"),
      ).toMatchObject({
        total: 10,
        live: 3,
        backfill: 7,
      });
    });

    it("reports IST calendar window boundaries", () => {
      const r = buildDataQualityReport(data());
      // 2026-10-15 11:30 IST → today starts 2026-10-15 00:00 IST = 2026-10-14T18:30Z.
      expect(r.coverage.windows.boundaries.today.from).toBe(
        "2026-10-14T18:30:00.000Z",
      );
      expect(r.coverage.windows.boundaries.monthToDate.from).toBe(
        "2026-09-30T18:30:00.000Z",
      );
    });
  });

  describe("identity", () => {
    it("looks recipients up in the collection their recipientRole names", () => {
      const r = buildDataQualityReport(
        data({
          recipients: [
            { influencerId: "inf1", recipientRole: "influencer", count: 2 },
            // Exists as an influencer but is a photographer recipient → must be missing.
            { influencerId: "ph1", recipientRole: "photographer", count: 1 },
            { influencerId: "x", recipientRole: null, count: 1 },
          ],
          existing: {
            ...data().existing,
            influencers: new Set(["inf1", "ph1"]),
            photographers: new Set(),
          },
        }),
      );
      expect(r.identity.recipients.influencer).toMatchObject({
        referenced: 1,
        missing: 0,
      });
      expect(r.identity.recipients.photographer).toMatchObject({
        referenced: 1,
        missing: 1,
        missingSample: ["ph1"],
      });
      expect(r.identity.recipients.withoutRecipientRole).toBe(1);
      expect(r.identity.recipientRoleDistribution).toEqual({
        influencer: 2,
        photographer: 1,
        none: 1,
      });
    });

    it("checks owners against brands or photographers by owner type, preferring event metadata", () => {
      const r = buildDataQualityReport(
        data({
          byCampaign: [
            {
              campaignId: "c1",
              brandId: "b1",
              eventType: "campaign_created",
              metaOwnerType: "brand",
              metaCampaignMode: "invite_only",
              count: 1,
            },
            {
              campaignId: "c2",
              brandId: "p1",
              eventType: "creator_invited",
              metaOwnerType: null,
              metaCampaignMode: null,
              count: 2,
            },
            {
              campaignId: "c3",
              brandId: "gone",
              eventType: "creator_invited",
              metaOwnerType: null,
              metaCampaignMode: null,
              count: 1,
            },
          ],
          campaigns: new Map([
            [
              "c1",
              {
                brandId: "b1",
                ownerType: "brand",
                campaignMode: "invite_only",
              },
            ],
            [
              "c2",
              {
                brandId: "p1",
                ownerType: "photographer",
                campaignMode: "invite_only",
              },
            ],
            ["c3", { brandId: "gone", ownerType: "brand", campaignMode: null }],
          ]),
          existing: {
            ...data().existing,
            brandOwners: new Set(["b1"]),
            photographerOwners: new Set(["p1"]),
          },
        }),
      );
      expect(r.identity.ownerTypeDistribution).toEqual({
        brand: 2,
        photographer: 2,
        unavailable: 0,
      });
      expect(r.identity.ownerTypeSource).toEqual({
        event: 1,
        currentCampaignState: 3,
        unavailable: 0,
      });
      expect(r.identity.owners).toMatchObject({
        referenced: 3,
        missingFromOwnerCollection: 1,
        missingSample: ["gone"],
      });
    });

    it("reports missing references only where the event type should carry them", () => {
      const r = buildDataQualityReport(
        data({
          perType: [
            perTypeRow("campaign_created", {
              missingInfluencerId: 1,
              missingInviteId: 1,
              missingRecipientRole: 1,
            }),
            perTypeRow("invite_accepted", {
              missingInfluencerId: 1,
              missingBrandId: 1,
            }),
          ],
        }),
      );
      const row = (t: string) =>
        r.identity.missingReferencesByEventType.find((m) => m.eventType === t);
      expect(row("campaign_created")).toMatchObject({
        missingRecipientId: 0,
        missingInviteId: 0,
        scope: "campaign",
      });
      expect(row("invite_accepted")).toMatchObject({
        missingRecipientId: 1,
        missingOwnerId: 1,
        scope: "invite",
      });
      expect(r.legacyIds.eventsWithNullOwnerId).toBe(1);
    });

    it("counts events whose campaign or invite no longer exists", () => {
      const r = buildDataQualityReport(
        data({
          byCampaign: [
            {
              campaignId: "c-gone",
              brandId: null,
              eventType: "campaign_created",
              metaOwnerType: null,
              metaCampaignMode: null,
              count: 1,
            },
          ],
          perInvite: [
            invite({ inviteId: "i-gone" }),
            invite({ inviteId: "i-ok" }),
          ],
          existing: { ...data().existing, invites: new Set(["i-ok"]) },
        }),
      );
      expect(r.identity.campaigns.missingFromCampaigns).toBe(1);
      expect(r.identity.invites).toMatchObject({
        missingFromCampaignInvites: 1,
        missingSample: ["i-gone"],
      });
    });

    it("separates resolvable from unresolvable legacy owner usernames, without trusting them", () => {
      const r = buildDataQualityReport(
        data({
          legacy: [
            {
              eventType: "creator_invited",
              field: "brandId",
              value: "acmebrand",
              campaignId: "c1",
              count: 3,
            },
            {
              eventType: "campaign_created",
              field: "brandId",
              value: "ghost",
              campaignId: "c2",
              count: 1,
            },
          ],
          resolvableLegacyOwners: new Set(["acmebrand"]),
        }),
      );
      expect(r.legacyIds).toMatchObject({
        eventsWithLegacyIds: 4,
        legacyOwnerRefs: { resolvableToCurrentOwner: 3, unresolvable: 1 },
      });
      expect(r.legacyIds.eventTypesAffected.sort()).toEqual([
        "campaign_created",
        "creator_invited",
      ]);
      expect(r.stage2bReadiness.warnings.join(" ")).toMatch(
        /1 event\(s\) with unresolvable legacy owner ids/,
      );
    });
  });

  describe("semantics", () => {
    it("reports where the actor (userId) differs from the creator (influencerId)", () => {
      const r = buildDataQualityReport(
        data({
          perType: [
            perTypeRow("invite_accepted", {
              total: 4,
              actorDiffersFromSubject: 1,
              missingUserId: 1,
            }),
          ],
        }),
      );
      expect(r.actorSemantics.perEventType).toEqual([
        {
          eventType: "invite_accepted",
          actorDiffersFromCreator: 1,
          systemOrUnknownActor: 1,
        },
      ]);
      expect(r.dataDictionary.actor).toMatch(/who performed the action/);
      expect(r.dataDictionary.creator).toMatch(/influencer OR a photographer/);
      expect(r.dataDictionary.campaignOwner).toMatch(/brand OR a photographer/);
    });

    it("keeps campaign-level and creator-level completion apart, and flags reversed approvals", () => {
      const r = buildDataQualityReport(
        data({
          typeSource: [
            {
              eventType: "campaign_completed",
              source: "live",
              count: 2,
              first: NOW,
              last: NOW,
            },
          ],
          perInvite: [
            invite({ inviteId: "ok", approvedAt: after(STAGE1, 5) }),
            invite({
              inviteId: "reversed",
              approvedAt: after(STAGE1, 5),
              rejectedAt: after(STAGE1, 9),
            }),
            invite({
              inviteId: "disputed-later",
              approvedAt: after(STAGE1, 5),
              lastDisputedAt: after(STAGE1, 7),
            }),
          ],
        }),
      );
      expect(r.completion).toMatchObject({
        campaignLevelCompletions: 2,
        creatorLevelApprovals: 3,
        approvedThenDisputedOrRejected: 2,
      });
    });

    it("counts campaign mode as event-sourced, current-state fallback, or unavailable", () => {
      const r = buildDataQualityReport(
        data({
          byCampaign: [
            {
              campaignId: "c1",
              brandId: "b",
              eventType: "creator_invited",
              metaOwnerType: null,
              metaCampaignMode: "invite_only",
              count: 2,
            },
            {
              campaignId: "c1",
              brandId: "b",
              eventType: "invite_accepted",
              metaOwnerType: null,
              metaCampaignMode: null,
              count: 3,
            },
            {
              campaignId: "gone",
              brandId: "b",
              eventType: "invite_accepted",
              metaOwnerType: null,
              metaCampaignMode: null,
              count: 1,
            },
          ],
          campaigns: new Map([
            [
              "c1",
              {
                brandId: "b",
                ownerType: "brand",
                campaignMode: "tier_filtered_open",
              },
            ],
          ]),
        }),
      );
      expect(r.campaignMode).toMatchObject({
        eventSourced: 2,
        currentStateFallback: 3,
        unavailable: 1,
      });
    });

    it("reports the open-campaign ambiguity and that creator_selected has no source", () => {
      const r = buildDataQualityReport(
        data({
          operational: {
            ...data().operational,
            openCampaignInvitesBeforeStage1: 9,
          },
        }),
      );
      expect(r.openCampaigns).toMatchObject({
        creatorSelectedEvents: 0,
        ambiguousHistoricalInvites: 9,
      });
      expect(
        r.stage2bReadiness.unavailableMetrics.map((m) => m.metric),
      ).toEqual(
        expect.arrayContaining([
          "creator selection (creator_selected)",
          "historical application vs owner-invite split",
        ]),
      );
    });
  });

  describe("timestamp ordering", () => {
    it("flags the pre-fix counter acceptance as a known issue without hiding other anomalies", () => {
      const r = buildDataQualityReport(
        data({
          perInvite: [
            invite({
              inviteId: "bad",
              counterSentAt: new Date("2026-09-30T04:11:28.779Z"),
              acceptedAt: new Date("2026-09-30T04:11:28.778Z"),
            }),
            invite({
              inviteId: "good",
              counterSentAt: after(STAGE15, 1),
              acceptedAt: after(STAGE15, 3),
            }),
            invite({
              inviteId: "odd",
              acceptedAt: after(STAGE1, 5),
              submittedAt: after(STAGE1, 2),
            }),
          ],
        }),
      );
      expect(r.knownIssues).toEqual([
        expect.objectContaining({
          id: "invite_accepted_counter_send_timestamp",
          count: 1,
          affectedInviteIds: ["bad"],
        }),
      ]);
      expect(r.timestampAnomalies.submittedBeforeAccepted).toEqual({
        count: 1,
        sampleInviteIds: ["odd"],
      });
      expect(r.stage2bReadiness.warnings.join(" ")).toMatch(
        /exclude from time-to-accept/,
      );
    });
  });

  describe("money", () => {
    const tx = (fields: any) => ({
      transactionType: "paid_collab",
      collectionStatus: "verified",
      payoutStatus: "paid",
      resolveOutcome: null,
      agreedAmount: 100000,
      payerTotal: 100000,
      platformFee: 0,
      recipientPayout: 100000,
      inviteId: "i1",
      ...fields,
    });

    it("reports collaboration totals in paise only when the unit matches invite data", () => {
      const r = buildDataQualityReport(
        data({
          transactions: [
            tx({}),
            tx({
              inviteId: "i2",
              payoutStatus: "pending",
              payerTotal: 50000,
              recipientPayout: 50000,
              agreedAmount: 50000,
            }),
          ],
          invitePaise: new Map([
            ["i1", 100000],
            ["i2", 50000],
          ]),
        }),
      );
      expect(r.financial.collaboration.moneyUnit).toMatchObject({
        unit: "paise",
        status: "verified",
        transactionsChecked: 2,
        mismatches: 0,
      });
      expect(r.financial.collaboration.totalsPaise).toEqual({
        collectedPayerTotal: 150000,
        platformFees: 0,
        paidOutToRecipients: 100000,
      });
    });

    it("suppresses monetary totals when the unit is inconsistent", () => {
      const r = buildDataQualityReport(
        data({
          transactions: [tx({ agreedAmount: 1000 })],
          invitePaise: new Map([["i1", 100000]]),
        }),
      );
      expect(r.financial.collaboration.moneyUnit.status).toBe("inconsistent");
      expect(r.financial.collaboration.totalsPaise).toBeNull();
      expect(
        r.stage2bReadiness.unavailableMetrics.map((m) => m.metric),
      ).toContain("collaboration money totals");
    });

    it("keeps platform payments separate and never sums them; separates payment stages", () => {
      const r = buildDataQualityReport(
        data({
          platformPayments: [
            { purpose: "subscription", gateway: "razorpay", count: 7 },
            { purpose: "subscription", gateway: "manual_upi", count: 6 },
          ],
          paymentStages: [
            { stage: "collection", count: 4 },
            { stage: "payout", count: 3 },
          ],
        }),
      );
      expect(r.financial.platformPayments.moneyUnit.status).toBe("mixed");
      // Counts only: no amount/total fields for the mixed-unit collection.
      expect(Object.keys(r.financial.platformPayments).sort()).toEqual([
        "moneyUnit",
        "rows",
        "source",
      ]);
      for (const row of r.financial.platformPayments.rows) {
        expect(Object.keys(row).sort()).toEqual([
          "count",
          "gateway",
          "purpose",
        ]);
      }
      expect(r.financial.paymentCompletedEvents).toMatchObject({
        collection: 4,
        payout: 3,
        unknownStage: 0,
      });
    });

    it("documents the three existing summary endpoints and their domains", () => {
      const r = buildDataQualityReport(data());
      expect(r.existingSummaries.map((s) => [s.endpoint, s.domain])).toEqual([
        ["GET /api/payments-payouts/summary", "marketplace"],
        ["GET /api/payment/summary", "platform"],
        ["GET /api/users/platform-stats", "platform (current state)"],
      ]);
    });
  });

  describe("small samples", () => {
    it(`flags entities below ${MIN_SAMPLE_SIZE} and warns when none qualify`, () => {
      const r = buildDataQualityReport(
        data({
          sampleSize: {
            creators: [
              { recipientRole: "influencer", total: 5, withMinSample: 0 },
              { recipientRole: "photographer", total: 2, withMinSample: 0 },
            ],
            owners: { total: 3, withMinSample: 0 },
          },
        }),
      );
      expect(r.sampleSize.minSampleSize).toBe(20);
      expect(r.sampleSize.creators).toEqual([
        { recipientRole: "influencer", entities: 5, withMinSample: 0 },
        { recipientRole: "photographer", entities: 2, withMinSample: 0 },
      ]);
      expect(r.stage2bReadiness.warnings.join(" ")).toMatch(
        /insufficient_data/,
      );
    });

    it("does not warn once an entity reaches the minimum", () => {
      const r = buildDataQualityReport(
        data({
          sampleSize: { creators: [], owners: { total: 1, withMinSample: 1 } },
        }),
      );
      expect(r.stage2bReadiness.warnings.join(" ")).not.toMatch(
        /insufficient_data/,
      );
    });
  });

  describe("readiness", () => {
    it("is blocked by duplicate dedupe keys", () => {
      const r = buildDataQualityReport(data({ duplicateDedupeKeys: 2 }));
      expect(r.stage2bReadiness.stage2bReady).toBe(false);
      expect(r.stage2bReadiness.blockers[0]).toMatch(/duplicate dedupeKey/);
    });

    it("is ready with warnings when only cohort/backfill caveats remain", () => {
      const r = buildDataQualityReport(data());
      expect(r.stage2bReadiness.stage2bReady).toBe(true);
      expect(r.stage2bReadiness.warnings.join(" ")).toMatch(
        /Backfill not applied/,
      );
      expect(
        r.stage2bReadiness.cohortLimitedMetrics.map((m) => m.metric),
      ).toEqual(
        expect.arrayContaining([
          "invite view rate",
          "decline rate",
          "counter-offer rate",
          "work-start rate",
          "dispute rate",
        ]),
      );
    });
  });

  describe("privacy", () => {
    it("never outputs contact details or free text fields", () => {
      const r = buildDataQualityReport(
        data({
          recipients: [
            { influencerId: "inf1", recipientRole: "influencer", count: 1 },
          ],
          perInvite: [invite({ inviteId: "i1", approvedAt: NOW })],
        }),
      );
      const json = JSON.stringify(r);
      for (const key of [
        '"email"',
        '"phone"',
        '"phoneNumber"',
        '"password"',
        '"message"',
        '"disputeReason"',
        '"withdrawnReason"',
        '"counterMessage"',
      ]) {
        expect(json).not.toContain(key);
      }
    });
  });
});
