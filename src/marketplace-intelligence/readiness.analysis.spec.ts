import {
  ReadinessInput,
  availabilityFor,
  buildReadinessReport,
  derivedMetricReadiness,
  eventCoverage,
  normalizationAudit,
} from "./readiness.analysis";
import { SIGNAL_CATEGORIES } from "./readiness.catalog";

const ev = (total: number, live = total) => ({
  total,
  live,
  backfill: total - live,
});

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    generatedAt: new Date("2026-10-02T00:00:00Z"),
    coverage: {
      influencer: {
        records: 100,
        fields: {
          approvedProfiles: 90,
          socialMediaAccounts: 100,
          socialHandle: 100,
          socialTier: 95,
          pricedContentTypes: 90,
          categories: 92,
          locationState: 100,
          locationDistrict: 85,
          languages: 90,
          collaborationAvailability: 90,
          lastLoginAt: 95,
          trendScore: 10,
          influencerCategory: 30,
          creatorTypes: 5,
          selfReportedEngagement: 3,
        },
      },
      socialAccount: {
        records: 120,
        fields: {
          socialAccountId: 120,
          ownershipVerified: 2,
          tierVerified: 1,
          observed: 1,
        },
      },
      brand: {
        records: 10,
        fields: { categories: 9, languages: 2, locationState: 8 },
      },
      campaign: {
        records: 30,
        fields: {
          platforms: 30,
          categories: 30,
          pricedDeliverables: 28,
          deliverables: 10,
          minInfluencerTier: 0,
          targetTiers: 0,
          followerRange: 0,
          targetState: 2,
          budget: 0,
          dates: 30,
        },
      },
    },
    creatorActivity: {
      creators: 100,
      hasLastLogin: 95,
      lastLogin30d: 10,
      lastLogin90d: 60,
    },
    campaignVolume: {
      total: 30,
      byStatus: { completed: 30 },
      byMode: { invite_only: 30 },
      byType: { paid_collab: 30 },
    },
    events: {
      creator_invited: ev(100),
      invite_accepted: ev(60),
      invite_declined: ev(30),
      content_submitted: ev(40),
      content_approved: ev(35),
      payment_completed: ev(35),
      work_started: ev(45),
      counter_offer_sent: ev(25),
      content_disputed: ev(1),
    },
    inviteStatusCounts: {
      pending: 10,
      declined: 30,
      approved: 35,
      working: 5,
      disputed: 1,
    },
    invitesPerCreator: {
      creators: 4,
      median: 25,
      max: 40,
      atLeastMinSample: 3,
    },
    distinct: {},
    masters: {
      categories: ["Fashion", "Food"],
      languages: ["Telugu", "English"],
      states: ["Telangana"],
      contentTypes: ["Reel", "Photo post", "Post"],
    },
    ...over,
  };
}

describe("availabilityFor", () => {
  it.each([
    [80, 100, "AVAILABLE"],
    [79, 100, "PARTIAL"],
    [20, 100, "PARTIAL"],
    [19, 100, "MISSING"],
    [0, 0, "MISSING"],
  ])("%d of %d → %s", (present, total, expected) => {
    expect(availabilityFor(present, total)).toBe(expected);
  });
});

describe("eventCoverage (cross-checked against invite state)", () => {
  it("flags outcomes that exist as invite state but were never recorded as events", () => {
    const rows = eventCoverage(
      input({
        events: { creator_invited: ev(10) },
        inviteStatusCounts: { declined: 6, pending: 4 },
      }),
    );
    const declined = rows.find((r) => r.eventType === "invite_declined")!;
    expect(declined).toMatchObject({
      total: 0,
      invitesImplyingEvent: 6,
      status: "missing_for_known_outcomes",
    });
    expect(rows.find((r) => r.eventType === "creator_invited")!.status).toBe(
      "complete",
    );
  });

  it("incomplete / no activity / not cross-checked", () => {
    const rows = eventCoverage(
      input({
        events: { invite_accepted: ev(3), campaign_created: ev(5) },
        inviteStatusCounts: { approved: 10 },
      }),
    );
    expect(rows.find((r) => r.eventType === "invite_accepted")!.status).toBe(
      "incomplete",
    );
    expect(rows.find((r) => r.eventType === "content_disputed")!.status).toBe(
      "no_activity",
    );
    expect(rows.find((r) => r.eventType === "campaign_created")!.status).toBe(
      "not_cross_checked",
    );
  });

  it("reports the live share of each event type", () => {
    const rows = eventCoverage(
      input({ events: { creator_invited: ev(10, 2) }, inviteStatusCounts: {} }),
    );
    expect(
      rows.find((r) => r.eventType === "creator_invited")!.liveSharePct,
    ).toBe(20);
  });
});

describe("derivedMetricReadiness", () => {
  const byMetric = (i: ReadinessInput) =>
    Object.fromEntries(derivedMetricReadiness(i).map((m) => [m.metric, m]));

  it("READY only when every required event is complete, live and well sampled", () => {
    const m = byMetric(input());
    expect(m["creator.acceptanceRate"].readiness).toBe("READY");
    expect(m["creator.acceptanceRate"].blockers).toEqual([]);
  });

  it("NOT_READY when known outcomes are missing from the event stream", () => {
    const m = byMetric(
      input({ events: { ...input().events, invite_declined: ev(0) } }),
    );
    expect(m["creator.responseRate"].readiness).toBe("NOT_READY");
    expect(m["creator.responseRate"].blockers[0]).toContain("invite_declined");
  });

  it("NOT_READY for metrics needing an event type the platform does not record", () => {
    const m = byMetric(input());
    expect(m["creator.counterOfferAcceptance"].readiness).toBe("NOT_READY");
    expect(m["creator.counterOfferAcceptance"].blockers.join(" ")).toContain(
      "counter_offer_accepted",
    );
  });

  it("incomplete coverage never yields READY", () => {
    const m = byMetric(
      input({
        inviteStatusCounts: { ...input().inviteStatusCounts, approved: 50 },
      }), // 35 approvals for 50 implying invites
    );
    expect(m["creator.completionRate"].readiness).not.toBe("READY");
  });

  it("READY_WITH_CAVEAT for mostly backfilled events, small samples or thin per-creator history", () => {
    const backfilled = byMetric(
      input({ events: { ...input().events, creator_invited: ev(100, 10) } }),
    );
    expect(backfilled["creator.acceptanceRate"].readiness).toBe(
      "READY_WITH_CAVEAT",
    );
    expect(backfilled["creator.acceptanceRate"].caveats.join(" ")).toContain(
      "10% live",
    );

    const thin = byMetric(
      input({
        invitesPerCreator: {
          creators: 30,
          median: 2,
          max: 9,
          atLeastMinSample: 0,
        },
      }),
    );
    expect(thin["creator.acceptanceRate"].readiness).toBe("READY_WITH_CAVEAT");
    expect(thin["creator.acceptanceRate"].caveats.join(" ")).toContain(
      "No creator has 20+ invites",
    );

    const small = byMetric(
      input({
        events: { ...input().events, creator_invited: ev(12) },
        inviteStatusCounts: { pending: 2, declined: 10 },
      }),
    );
    expect(small["creator.acceptanceRate"].caveats.join(" ")).toContain(
      "Only 12 denominator",
    );
  });
});

describe("normalizationAudit", () => {
  const audit = (distinct: ReadinessInput["distinct"]) =>
    Object.fromEntries(
      normalizationAudit(input({ distinct })).map((n) => [n.field, n]),
    );

  it("canonical fields are detected as canonical", () => {
    const a = audit({
      "creator.platform": [
        { value: "Instagram", count: 5 },
        { value: "X / Twitter", count: 1 },
      ],
      "creator.tier": [
        { value: "Micro", count: 5 },
        { value: "Mega / Celebrity", count: 1 },
      ],
      "creator.categories": [{ value: "Fashion", count: 3 }],
    });
    expect(a["creator.socialMedia.platform"].canonical).toBe(true);
    expect(a["creator.socialMedia.tier"].canonical).toBe(true);
    expect(a["creator.categories"].canonical).toBe(true);
  });

  it("detects values outside the master list and spelling variants of one value", () => {
    const a = audit({
      "creator.categories": [
        { value: "Fashion", count: 3 },
        { value: "fashion ", count: 1 },
        { value: "Cooking", count: 2 },
      ],
      "creator.platform": [
        { value: "Instagram", count: 3 },
        { value: "instagram", count: 1 },
        { value: "Snapchat", count: 1 },
      ],
      "creator.tier": [
        { value: "Mid tier", count: 1 },
        { value: "Mid-Tier", count: 4 },
        { value: "Gold", count: 1 },
      ],
    });
    expect(a["creator.categories"].nonCanonical.map((v) => v.value)).toEqual([
      "fashion ",
      "Cooking",
    ]);
    expect(a["creator.categories"].spellingVariants).toEqual([
      ["Fashion", "fashion "],
    ]);
    expect(
      a["creator.socialMedia.platform"].nonCanonical.map((v) => v.value),
    ).toEqual(["Snapchat"]);
    expect(a["creator.socialMedia.platform"].spellingVariants).toEqual([
      ["Instagram", "instagram"],
    ]);
    expect(a["creator.socialMedia.tier"].spellingVariants).toEqual([
      ["Mid tier", "Mid-Tier"],
    ]);
    expect(
      a["creator.socialMedia.tier"].nonCanonical.map((v) => v.value),
    ).toEqual(["Gold"]);
    expect(a["creator.categories"].canonical).toBe(false);
  });

  it("free text is never canonical; an unused field is null, not canonical", () => {
    const a = audit({
      "campaign.deliverables": [{ value: "1 Reel or", count: 1 }],
      "creator.country": [{ value: null, count: 267 }],
    });
    expect(a["campaign.deliverables"].canonical).toBe(false);
    expect(a["creator.location.country"]).toMatchObject({
      canonical: null,
      emptyOrNull: 267,
      distinctValues: 0,
    });
    expect(a["campaign.minInfluencerTier"].canonical).toBeNull();
  });
});

describe("buildReadinessReport", () => {
  it("returns every required section and every signal category", () => {
    const r = buildReadinessReport(input());
    for (const key of [
      "summary",
      "creatorSignals",
      "brandSignals",
      "campaignSignals",
      "historicalSignals",
      "normalizationIssues",
      "derivedMetricReadiness",
      "missingData",
      "currentSearchAndRanking",
      "dataConfidenceSemantics",
      "futureMatchingContract",
    ]) {
      expect(r).toHaveProperty(key);
    }
    expect(r.readOnly).toBe(true);
    expect(r.summary.signalCategories).toEqual(SIGNAL_CATEGORIES);
    const used = new Set(
      [...r.creatorSignals, ...r.brandSignals].map((s) => s.category),
    );
    for (const c of [
      "IDENTITY",
      "PLATFORM",
      "AUDIENCE",
      "CONTENT",
      "CATEGORY",
      "GEOGRAPHY",
      "LANGUAGE",
      "AVAILABILITY",
      "PERFORMANCE",
    ]) {
      expect(used.has(c as any)).toBe(true);
    }
  });

  it("represents unreliable, missing and nullable signals explicitly", () => {
    const r = buildReadinessReport(input());
    const sig = Object.fromEntries(r.creatorSignals.map((s) => [s.signal, s]));
    expect(sig["creator.followersCount"]).toMatchObject({
      availability: "UNRELIABLE",
      safeForMatching: "no",
    });
    expect(sig["creator.location.country"].availability).toBe("MISSING");
    expect(sig["creator.trendScore"]).toMatchObject({
      availability: "MISSING",
      nullable: true,
      derived: true,
    });
    expect(sig["creator.categories"]).toMatchObject({
      availability: "AVAILABLE",
      coverage: { present: 92, of: 100, pct: 92 },
    });
    expect(sig["creator.influencerCategory"].availability).toBe("PARTIAL");
    expect(sig["creator.approval"].availability).toBe("AVAILABLE");
  });

  it("campaign requirements: unsupported ones are MISSING; unused ones show their usage", () => {
    const r = buildReadinessReport(input());
    const req = Object.fromEntries(
      r.campaignSignals.map((c) => [c.requirement, c]),
    );
    expect(req["Language"]).toMatchObject({
      stored: false,
      availability: "MISSING",
    });
    expect(req["Follower range"]).toMatchObject({
      supportedInForm: false,
      availability: "MISSING",
    });
    expect(req["Platform"]).toMatchObject({
      availability: "AVAILABLE",
      usedInEligibility: true,
    });
    expect(req["Location (state / district / cities)"].coverage).toEqual({
      present: 2,
      of: 30,
      pct: 6.7,
    });
  });

  it("missing data is grouped by priority; no critical gaps when the critical signals are available", () => {
    const r = buildReadinessReport(input());
    expect(r.missingData.critical).toEqual([]);
    expect(r.missingData.important.map((g) => g.signal)).toEqual(
      expect.arrayContaining([
        "creator.verifiedTier",
        "creator.observedFollowers",
        "campaign.Language",
      ]),
    );
    expect(r.summary.criticalGaps).toBe(0);
  });

  it("a missing critical signal makes the verdict NOT READY", () => {
    const i = input();
    i.coverage.influencer.fields.categories = 5;
    const r = buildReadinessReport(i);
    expect(r.missingData.critical.map((g) => g.signal)).toContain(
      "creator.categories",
    );
    expect(r.summary.verdict).toMatch(/^NOT READY/);
  });

  it("does not mutate its input", () => {
    const i = input();
    const snapshot = JSON.stringify(i);
    buildReadinessReport(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });

  it("flags a tiny campaign history in the summary", () => {
    const r = buildReadinessReport(
      input({
        campaignVolume: { total: 16, byStatus: {}, byMode: {}, byType: {} },
      }),
    );
    expect(r.summary.caveats.join(" ")).toContain("Only 16 campaigns");
  });
});
