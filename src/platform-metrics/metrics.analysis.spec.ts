import {
  PLATFORM_EVENT_COHORTS,
  cohortStart,
} from "../platform-events/platform-event-coverage";
import {
  MIN_SAMPLE_SIZE,
  buildAttributeCoverage,
  buildCampaignMetrics,
  buildCreatorMetrics,
  buildOverview,
  buildOwnerMetrics,
  buildRelationships,
  buildTimeSeries,
  coverageStatus,
  durations,
  inviteOnlyFunnel,
  isCompleted,
  isReversed,
  journeysInWindow,
  openCampaignFunnel,
  platformBreakdown,
  rate,
  resolveCampaignMode,
  resolveOwnerType,
  resolveRole,
} from "./metrics.analysis";
import {
  CampaignRecord,
  InviteJourney,
  JourneyData,
  Step,
} from "./metrics.types";

const STAGE1 = cohortStart(PLATFORM_EVENT_COHORTS.stage1);
const STAGE15 = cohortStart(PLATFORM_EVENT_COHORTS.stage15);
const NOW = new Date("2026-10-15T06:00:00.000Z"); // 11:30 IST
const h = (base: Date, hours: number) =>
  new Date(base.getTime() + hours * 3600_000);
const none: Step = { at: null, source: null };
const live = (at: Date): Step => ({ at, source: "live" });
const bf = (at: Date): Step => ({ at, source: "backfill" });

function journey(o: Partial<InviteJourney> = {}): InviteJourney {
  return {
    inviteId: "i0",
    campaignId: "c1",
    ownerId: "o1",
    creatorId: "u1",
    recipientRole: "influencer",
    platform: "instagram",
    eventCampaignMode: "invite_only",
    invited: none,
    applied: none,
    viewed: none,
    counterSent: none,
    accepted: none,
    declined: none,
    workStarted: none,
    submitted: none,
    approved: none,
    rejected: none,
    firstDisputed: none,
    lastDisputed: none,
    withdrawn: none,
    withdrawnReason: null,
    collection: none,
    payout: none,
    collectionPaise: null,
    payoutPaise: null,
    ...o,
  };
}

function campaign(o: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    campaignId: "c1",
    ownerId: "o1",
    created: none,
    completed: none,
    completedBy: null,
    eventCampaignMode: null,
    eventCampaignType: null,
    eventOwnerType: null,
    current: null,
    ...o,
  };
}

const data = (
  journeys: InviteJourney[],
  campaigns: CampaignRecord[] = [],
): JourneyData => ({
  now: NOW,
  journeys,
  campaigns: new Map(campaigns.map((c) => [c.campaignId, c])),
});

/** n invites entered after Stage 1.5 via a live creator_invited. */
const many = (
  n: number,
  o: (i: number) => Partial<InviteJourney> = () => ({}),
) =>
  Array.from({ length: n }, (_, i) =>
    journey({
      inviteId: `i${String(i).padStart(3, "0")}`,
      invited: live(h(STAGE15, 1 + i)),
      ...o(i),
    }),
  );

describe("Stage 2B metrics analysis", () => {
  describe("small samples", () => {
    it(`returns no rate below ${MIN_SAMPLE_SIZE} and a rate at ${MIN_SAMPLE_SIZE}`, () => {
      expect(rate(19, 19)).toEqual({
        numerator: 19,
        denominator: 19,
        sampleSize: 19,
        rate: null,
        status: "insufficient_data",
      });
      expect(rate(5, 20)).toEqual({
        numerator: 5,
        denominator: 20,
        sampleSize: 20,
        rate: 0.25,
        status: "ok",
      });
      expect(rate(0, 0).status).toBe("insufficient_data");
    });

    it("withholds duration statistics below the threshold", () => {
      const few = many(3, () => ({ accepted: live(h(STAGE15, 50)) }));
      expect(
        durations(
          few,
          (j) => j.invited,
          (j) => j.accepted,
        ),
      ).toMatchObject({
        sampleSize: 3,
        medianHours: null,
        status: "insufficient_data",
      });
    });

    it("computes median and average, skipping out-of-order pairs, and counts derived pairs", () => {
      const js = [
        ...many(20, (i) => ({
          accepted: live(h(STAGE15, 1 + i + (i < 10 ? 2 : 4))),
        })), // 10×2h, 10×4h
        journey({
          inviteId: "bad",
          invited: live(h(STAGE15, 10)),
          accepted: live(h(STAGE15, 5)),
        }),
        journey({
          inviteId: "old",
          invited: bf(h(STAGE1, -100)),
          accepted: bf(h(STAGE1, -99)),
        }),
      ];
      const d = durations(
        js,
        (j) => j.invited,
        (j) => j.accepted,
      );
      // Sorted: 1h, 10×2h, 10×4h → the 11th value is 2h.
      expect(d).toMatchObject({
        sampleSize: 21,
        medianHours: 2,
        status: "ok",
        derivedPairs: 1,
      });
      expect(d.averageHours).toBeCloseTo((10 * 2 + 10 * 4 + 1) / 21, 1);
    });
  });

  describe("attribution", () => {
    it("treats a missing recipientRole as a labelled legacy influencer", () => {
      expect(resolveRole(journey({ recipientRole: null }))).toEqual({
        role: "influencer",
        roleSource: "legacy_default",
      });
      expect(resolveRole(journey({ recipientRole: "photographer" }))).toEqual({
        role: "photographer",
        roleSource: "event",
      });
    });

    it("prefers event campaign mode, then campaign_created, then current state", () => {
      const c = campaign({
        eventCampaignMode: "tier_filtered_open",
        current: {
          campaignMode: "invite_only",
          campaignType: null,
          ownerType: null,
          status: null,
        },
      });
      expect(
        resolveCampaignMode(journey({ eventCampaignMode: "invite_only" }), c),
      ).toEqual({ value: "invite_only", source: "event" });
      expect(
        resolveCampaignMode(journey({ eventCampaignMode: null }), c),
      ).toEqual({ value: "tier_filtered_open", source: "event" });
      expect(
        resolveCampaignMode(null, campaign({ current: c.current })),
      ).toEqual({ value: "invite_only", source: "current_campaign_state" });
      expect(resolveCampaignMode(null, undefined)).toEqual({
        value: null,
        source: "unavailable",
      });
    });

    it("resolves owners as brand or photographer, never assuming brand", () => {
      expect(
        resolveOwnerType(campaign({ eventOwnerType: "photographer" })),
      ).toEqual({ value: "photographer", source: "event" });
      expect(
        resolveOwnerType(
          campaign({
            current: {
              ownerType: "brand",
              campaignMode: null,
              campaignType: null,
              status: null,
            },
          }),
        ),
      ).toEqual({
        value: "brand",
        source: "current_campaign_state",
      });
      expect(resolveOwnerType(undefined)).toEqual({
        value: null,
        source: "unavailable",
      });
    });
  });

  describe("completion semantics", () => {
    it("counts an approval as completed only if nothing later reverses it", () => {
      const ok = journey({ approved: live(h(STAGE1, 5)) });
      const rejectedLater = journey({
        approved: live(h(STAGE1, 5)),
        rejected: live(h(STAGE1, 9)),
      });
      const disputedLater = journey({
        approved: live(h(STAGE1, 5)),
        lastDisputed: live(h(STAGE1, 7)),
      });
      const disputedBefore = journey({
        approved: live(h(STAGE1, 5)),
        lastDisputed: live(h(STAGE1, 2)),
      });
      expect(
        [ok, rejectedLater, disputedLater, disputedBefore].map(isCompleted),
      ).toEqual([true, false, false, true]);
      expect(isReversed(rejectedLater)).toBe(true);
    });
  });

  describe("invite-only funnel cohorts", () => {
    it("counts viewed/declined only for live invites after Stage 1, and counter/work/dispute only after Stage 1.5", () => {
      const js = [
        journey({
          inviteId: "pre",
          invited: bf(h(STAGE1, -48)),
          accepted: bf(h(STAGE1, -40)),
          viewed: live(h(STAGE1, 1)),
        }),
        journey({
          inviteId: "s1",
          invited: live(h(STAGE1, 1)),
          viewed: live(h(STAGE1, 2)),
          accepted: live(h(STAGE1, 3)),
        }),
        journey({
          inviteId: "s15",
          invited: live(h(STAGE15, 1)),
          counterSent: live(h(STAGE15, 2)),
          accepted: live(h(STAGE15, 3)),
          workStarted: live(h(STAGE15, 4)),
        }),
      ];
      const f = inviteOnlyFunnel(js);
      const step = (s: string) => f.steps.find((x) => x.step === s)!;
      expect(step("invite_viewed")).toMatchObject({
        basis: "since_stage1",
        eligible: 2,
        count: 1,
      });
      expect(step("counter_offer_sent")).toMatchObject({
        basis: "since_stage15",
        eligible: 1,
        count: 1,
      });
      expect(step("work_started")).toMatchObject({
        basis: "since_stage15",
        eligible: 1,
        count: 1,
      });
      // Backfilled history counts for all_history steps.
      expect(step("invite_accepted")).toMatchObject({
        basis: "all_history",
        eligible: 3,
        count: 3,
      });
    });

    it("excludes the pre-fix counter acceptance from time-to-accept", () => {
      const js = [
        ...many(20, (i) => ({ accepted: live(h(STAGE15, 3 + i)) })),
        journey({
          inviteId: "known",
          invited: live(h(STAGE15, 1)),
          counterSent: live(h(STAGE15, 2)),
          accepted: live(h(STAGE15, 1.5)),
        }),
      ];
      expect(inviteOnlyFunnel(js).timeToStep.invitedToAccepted.sampleSize).toBe(
        20,
      );
    });
  });

  describe("open-campaign funnel", () => {
    it("starts from applications and reports creator_selected as unavailable", () => {
      const apps = [
        journey({
          inviteId: "a1",
          eventCampaignMode: "tier_filtered_open",
          applied: live(h(STAGE1, 1)),
          accepted: live(h(STAGE1, 2)),
        }),
        journey({
          inviteId: "a2",
          eventCampaignMode: "tier_filtered_open",
          applied: live(h(STAGE1, 1)),
        }),
      ];
      const f = openCampaignFunnel(apps, 4);
      expect(f.applications).toBe(2);
      expect(f.steps[0]).toMatchObject({
        step: "invite_accepted",
        eligible: 2,
        count: 1,
      });
      expect(f.creatorSelected).toBe("unavailable");
      expect(f.ownerInvitesOnOpenCampaigns).toBe(4);
    });
  });

  describe("windows", () => {
    it("places invites by their entry time on IST calendar days", () => {
      const yesterdayIst = new Date("2026-10-14T10:00:00.000Z");
      const js = [
        journey({ inviteId: "y", invited: live(yesterdayIst) }),
        journey({ inviteId: "t", invited: live(h(NOW, -1)) }),
      ];
      expect(
        journeysInWindow(data(js), "yesterday").map((j) => j.inviteId),
      ).toEqual(["y"]);
      expect(
        journeysInWindow(data(js), "today").map((j) => j.inviteId),
      ).toEqual(["t"]);
      expect(journeysInWindow(data(js), "all")).toHaveLength(2);
    });

    it("shapes time series by IST bucket with live and backfill apart", () => {
      const ts = buildTimeSeries("all", NOW, [
        {
          bucket: "2026-09",
          eventType: "creator_invited",
          source: "backfill",
          count: 5,
        },
        {
          bucket: "2026-09",
          eventType: "creator_invited",
          source: "live",
          count: 1,
        },
        {
          bucket: "2026-08",
          eventType: "campaign_created",
          source: "backfill",
          count: 2,
        },
      ]);
      expect(ts.bucket).toBe("month");
      expect(ts.series.map((s) => s.bucket)).toEqual(["2026-08", "2026-09"]);
      expect(ts.series[1].byEventType.creator_invited).toEqual({
        live: 1,
        backfill: 5,
      });
    });
  });

  describe("overview", () => {
    it("separates collection and payout money and reports invites that cannot enter a window", () => {
      const js = [
        journey({
          inviteId: "p",
          invited: live(h(NOW, -2)),
          collection: live(h(NOW, -1.5)),
          collectionPaise: 118000,
          payout: live(h(NOW, -1)),
          payoutPaise: 100000,
        }),
        journey({ inviteId: "orphan", accepted: bf(h(STAGE1, -5)) }), // no creator_invited / applied
      ];
      const o = buildOverview(
        data(js),
        "today",
        [{ eventType: "creator_invited", source: "live", count: 1 }],
        3,
      );
      expect(o.activity.money).toMatchObject({
        unit: "paise",
        collected: 118000,
        paidOut: 100000,
      });
      expect(o.cohort.invitesWithoutEntryEvent).toBe(1);
      expect(o.activity.activeCampaignsNow).toEqual({
        count: 3,
        source: "current_campaign_state",
      });
      expect(o.activity.byEventType.creator_invited).toEqual({
        live: 1,
        backfill: 0,
        total: 1,
      });
    });

    it("splits invite-only and open-campaign journeys by mode", () => {
      const js = [
        journey({ inviteId: "io", invited: live(h(NOW, -3)) }),
        journey({
          inviteId: "op",
          eventCampaignMode: "tier_filtered_open",
          applied: live(h(NOW, -3)),
        }),
      ];
      const o = buildOverview(data(js), "all", [], 0);
      expect(o.inviteOnlyFunnel.invites).toBe(1);
      expect(o.openCampaignFunnel.applications).toBe(1);
    });

    it("normalises platforms and keeps unknown separate", () => {
      const rows = platformBreakdown([
        journey({ inviteId: "1", platform: "Instagram", invited: live(NOW) }),
        journey({ inviteId: "2", platform: "x", invited: live(NOW) }),
        journey({ inviteId: "3", platform: null, invited: live(NOW) }),
      ]);
      expect(rows.map((r) => r.platform)).toEqual([
        "instagram",
        "twitter",
        "unknown",
      ]);
    });
  });

  describe("entity metrics (no rankings)", () => {
    it("groups creators by creatorId + role, ordered by id, with rates withheld below the threshold", () => {
      const js = [
        journey({
          inviteId: "1",
          creatorId: "zzz",
          invited: live(h(NOW, -5)),
          accepted: live(h(NOW, -4)),
        }),
        journey({
          inviteId: "2",
          creatorId: "aaa",
          recipientRole: null,
          invited: live(h(NOW, -5)),
        }),
        journey({
          inviteId: "3",
          creatorId: "ppp",
          recipientRole: "photographer",
          invited: live(h(NOW, -5)),
        }),
      ];
      const r = buildCreatorMetrics(data(js), "all", { limit: 10, offset: 0 });
      expect(
        r.rows.map((x) => [
          x.creatorId,
          x.recipientRole,
          x.recipientRoleSource,
        ]),
      ).toEqual(
        [
          ["aaa", "influencer", "legacy_default"],
          ["zzz", "influencer", "event"],
          ["ppp", "photographer", "event"],
        ].sort((a, b) => `${a[1]}:${a[0]}`.localeCompare(`${b[1]}:${b[0]}`)),
      );
      expect(r.ordering).toMatch(/not a ranking/);
      expect(r.rows.every((x) => x.rates.inviteAcceptance.rate === null)).toBe(
        true,
      );
      expect(
        buildCreatorMetrics(data(js), "all", {
          role: "photographer",
          limit: 10,
          offset: 0,
        }).total,
      ).toBe(1);
    });

    it("gives a creator a rate once they reach the threshold", () => {
      const js = many(20, (i) => ({
        creatorId: "busy",
        accepted: i < 5 ? live(h(STAGE15, 100)) : none,
      }));
      const r = buildCreatorMetrics(data(js), "all", { limit: 10, offset: 0 });
      expect(r.rows[0].rates.inviteAcceptance).toMatchObject({
        numerator: 5,
        denominator: 20,
        rate: 0.25,
        status: "ok",
      });
    });

    it("groups owners by owner type, including photographer owners", () => {
      const js = [
        journey({
          inviteId: "1",
          campaignId: "cb",
          ownerId: "brand1",
          invited: live(h(NOW, -3)),
        }),
        journey({
          inviteId: "2",
          campaignId: "cp",
          ownerId: "photo1",
          invited: live(h(NOW, -3)),
        }),
      ];
      const cs = [
        campaign({
          campaignId: "cb",
          ownerId: "brand1",
          eventOwnerType: "brand",
          created: live(h(NOW, -4)),
        }),
        campaign({
          campaignId: "cp",
          ownerId: "photo1",
          eventOwnerType: "photographer",
          created: live(h(NOW, -4)),
        }),
      ];
      const all = buildOwnerMetrics(data(js, cs), "all", {
        limit: 10,
        offset: 0,
      });
      expect(
        all.rows.map((r) => [r.ownerId, r.ownerType, r.campaignsCreated]),
      ).toEqual([
        ["brand1", "brand", 1],
        ["photo1", "photographer", 1],
      ]);
      expect(
        buildOwnerMetrics(data(js, cs), "all", {
          ownerType: "photographer",
          limit: 10,
          offset: 0,
        }).rows,
      ).toHaveLength(1);
    });

    it("reports campaign lifecycle and applies the window to creation time", () => {
      const cs = [
        campaign({
          campaignId: "c1",
          created: bf(h(STAGE1, -48)),
          completed: bf(h(STAGE1, -24)),
          eventCampaignMode: "invite_only",
        }),
        campaign({ campaignId: "c2", created: live(h(NOW, -1)) }),
      ];
      const all = buildCampaignMetrics(data([], cs), "all", {
        limit: 10,
        offset: 0,
      });
      expect(all.rows.find((r) => r.campaignId === "c1")).toMatchObject({
        lifecycleHours: 24,
        campaignModeSource: "event",
      });
      expect(
        buildCampaignMetrics(data([], cs), "today", {
          limit: 10,
          offset: 0,
        }).rows.map((r) => r.campaignId),
      ).toEqual(["c2"]);
    });

    it("paginates", () => {
      const r = buildCreatorMetrics(
        data(many(5, (i) => ({ creatorId: `c${i}` }))),
        "all",
        { limit: 2, offset: 2 },
      );
      expect(r).toMatchObject({ total: 5, limit: 2, offset: 2 });
      expect(r.rows.map((x) => x.creatorId)).toEqual(["c2", "c3"]);
    });
  });

  describe("relationships", () => {
    it("returns raw step history with outcomes, filtered by creator or campaign", () => {
      const js = [
        journey({
          inviteId: "a",
          creatorId: "u1",
          invited: bf(h(STAGE1, -10)),
          approved: bf(h(STAGE1, -2)),
        }),
        journey({
          inviteId: "b",
          creatorId: "u2",
          invited: live(h(STAGE1, 1)),
          withdrawn: live(h(STAGE1, 3)),
          withdrawnReason: "auto_close",
        }),
      ];
      const r = buildRelationships(data(js), {
        creatorId: "u2",
        limit: 10,
        offset: 0,
      });
      expect(r.total).toBe(1);
      expect(r.rows[0]).toMatchObject({
        inviteId: "b",
        entry: "invited",
        outcome: "withdrawn:auto_close",
      });
      expect(r.rows[0].steps.invited).toEqual({
        at: h(STAGE1, 1).toISOString(),
        source: "live",
      });
      expect(r.rows[0].steps.accepted).toBeNull();
      // No derived judgement fields — only raw steps and an outcome label.
      for (const key of Object.keys(r.rows[0]))
        expect(key).not.toMatch(/score|rank|recommend/i);
    });
  });

  describe("attribute coverage", () => {
    it("classifies coverage as reliable / sparse / missing", () => {
      expect(coverageStatus(80, 100).status).toBe("reliable");
      expect(coverageStatus(20, 100).status).toBe("sparse");
      expect(coverageStatus(19, 100).status).toBe("missing");
      expect(coverageStatus(0, 0).status).toBe("no_records");
      const r = buildAttributeCoverage([
        {
          entity: "influencer",
          collection: "influencers",
          total: 10,
          fields: { followersCount: 0 },
        },
      ]);
      expect(r.entities[0].fields[0]).toEqual({
        field: "followersCount",
        present: 0,
        coveragePct: 0,
        status: "missing",
      });
    });
  });

  describe("privacy", () => {
    it("never outputs contact details or free text", () => {
      const js = [
        journey({
          inviteId: "a",
          invited: live(NOW),
          withdrawn: live(NOW),
          withdrawnReason: "owner",
        }),
      ];
      const json = JSON.stringify([
        buildOverview(data(js), "all", [], 0),
        buildCreatorMetrics(data(js), "all", { limit: 5, offset: 0 }),
        buildRelationships(data(js), { limit: 5, offset: 0 }),
      ]);
      for (const k of [
        '"email"',
        '"phone"',
        '"phoneNumber"',
        '"message"',
        '"disputeReason"',
        '"withdrawnReason"',
        '"name"',
      ]) {
        expect(json).not.toContain(k);
      }
    });
  });
});
