import { PLATFORM_EVENT_TYPES } from "../platform-events/platform-event-types";
import {
  derivePlatformKey,
  isKnownPlatformKey,
} from "../utils/social-account.util";
import { CANONICAL_TIERS, resolveTier } from "../utils/tier-ranges.util";
import {
  Availability,
  BRAND_SIGNALS,
  CAMPAIGN_REQUIREMENTS,
  CREATOR_SIGNALS,
  DATA_CONFIDENCE_SEMANTICS,
  FUTURE_MATCHING_CONTRACT,
  SEARCH_AND_RANKING,
  SIGNAL_CATEGORIES,
  SignalDefinition,
} from "./readiness.catalog";

/**
 * Stage 3B-0 — the LIVE half of the readiness audit. Pure: takes counts and
 * distinct values measured read-only by the service and classifies them.
 * No scoring, no ranking, no matching, no writes.
 */

/** Same threshold Stage 2A/2B use before reporting a rate. */
export const MIN_SAMPLE_SIZE = 20;

export interface ValueCount {
  value: string | null;
  count: number;
}

export interface EventTypeCount {
  total: number;
  live: number;
  backfill: number;
}

export interface ReadinessInput {
  generatedAt: Date;
  /** entity → { records, fields: present-count per coverage field }. */
  coverage: Record<string, { records: number; fields: Record<string, number> }>;
  creatorActivity: {
    creators: number;
    hasLastLogin: number;
    lastLogin30d: number;
    lastLogin90d: number;
  };
  campaignVolume: {
    total: number;
    byStatus: Record<string, number>;
    byMode: Record<string, number>;
    byType: Record<string, number>;
  };
  events: Record<string, EventTypeCount>;
  inviteStatusCounts: Record<string, number>;
  invitesPerCreator: {
    creators: number;
    median: number;
    max: number;
    atLeastMinSample: number;
  };
  distinct: Record<string, ValueCount[]>;
  masters: {
    categories: string[];
    languages: string[];
    states: string[];
    contentTypes: string[];
  };
}

// ── Availability ──────────────────────────────────────────────────────────

export function availabilityFor(present: number, total: number): Availability {
  if (!total) return "MISSING";
  const pct = present / total;
  if (pct >= 0.8) return "AVAILABLE";
  if (pct >= 0.2) return "PARTIAL";
  return "MISSING";
}

function pct(present: number, total: number): number | null {
  return total ? Math.round((present / total) * 1000) / 10 : null;
}

function signalRow(def: SignalDefinition, input: ReadinessInput) {
  const cov = def.coverage ? input.coverage[def.coverage.entity] : undefined;
  const present = def.coverage
    ? (cov?.fields?.[def.coverage.field] ?? 0)
    : null;
  const records = cov?.records ?? null;
  const availability: Availability =
    def.availabilityOverride ?? availabilityFor(present ?? 0, records ?? 0);
  return {
    signal: def.signal,
    category: def.category,
    source: def.source,
    type: def.type,
    availability,
    nullable: def.nullable,
    derived: def.derived,
    currentUsage: def.currentUsage,
    safeForMatching: def.safeForMatching,
    priority: def.priority,
    coverage:
      present === null
        ? null
        : {
            present,
            of: records,
            entity: def.coverage?.entity,
            pct: pct(present, records ?? 0),
          },
    notes: def.notes,
  };
}

// ── Historical outcomes & derived metrics ─────────────────────────────────

/**
 * Invite statuses that imply an event must already have happened. Used to
 * cross-check event coverage against current state: an outcome visible in
 * invite status but absent from platform_events means the event stream is
 * incomplete for that step.
 */
const ACCEPTED_OR_LATER = [
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "completed",
  "approved",
  "disputed",
];
export const IMPLIED_BY_STATUS: Record<string, string[]> = {
  creator_invited: [
    "pending",
    "invited",
    "counter_sent",
    "declined",
    "withdrawn",
    ...ACCEPTED_OR_LATER,
  ],
  invite_accepted: ACCEPTED_OR_LATER,
  invite_declined: ["declined"],
  invite_withdrawn: ["withdrawn"],
  counter_offer_sent: ["counter_sent"],
  work_started: ["working", "submitted", "completed", "approved", "disputed"],
  content_submitted: ["submitted", "completed", "approved", "disputed"],
  content_approved: ["completed", "approved"],
  content_disputed: ["disputed"],
};

export function eventCoverage(input: ReadinessInput) {
  return [...PLATFORM_EVENT_TYPES].map((eventType) => {
    const counts = input.events[eventType] ?? {
      total: 0,
      live: 0,
      backfill: 0,
    };
    const statuses = IMPLIED_BY_STATUS[eventType];
    const implied = statuses
      ? statuses.reduce((sum, s) => sum + (input.inviteStatusCounts[s] || 0), 0)
      : null;
    let status:
      | "complete"
      | "incomplete"
      | "missing_for_known_outcomes"
      | "no_activity"
      | "not_cross_checked";
    if (implied === null)
      status = counts.total ? "not_cross_checked" : "no_activity";
    else if (implied > 0 && counts.total === 0)
      status = "missing_for_known_outcomes";
    else if (implied > 0 && counts.total < implied) status = "incomplete";
    else if (counts.total === 0) status = "no_activity";
    else status = "complete";
    return {
      eventType,
      ...counts,
      liveSharePct: pct(counts.live, counts.total),
      invitesImplyingEvent: implied,
      status,
    };
  });
}

interface DerivedMetricDefinition {
  metric: string;
  description: string;
  numerator: string[];
  denominator: string[];
  /** Per creator (needs per-entity samples) vs platform-wide. */
  perEntity: boolean;
  /** Event types the metric needs that the platform does not record at all. */
  untrackedEvents?: string[];
  knownLimitations?: string[];
}

export const DERIVED_METRICS: DerivedMetricDefinition[] = [
  {
    metric: "creator.acceptanceRate",
    description: "accepted invites / invites received",
    numerator: ["invite_accepted"],
    denominator: ["creator_invited"],
    perEntity: true,
  },
  {
    metric: "creator.responseRate",
    description: "(accepted + declined) / invites received",
    numerator: ["invite_accepted", "invite_declined"],
    denominator: ["creator_invited"],
    perEntity: true,
  },
  {
    metric: "creator.completionRate",
    description: "approved deliveries / accepted invites",
    numerator: ["content_approved"],
    denominator: ["invite_accepted"],
    perEntity: true,
  },
  {
    metric: "creator.approvalRate",
    description: "approved submissions / submissions",
    numerator: ["content_approved"],
    denominator: ["content_submitted"],
    perEntity: true,
    knownLimitations: [
      "Rejections (content_rejected) return work to the creator, so one invite can have several submissions.",
    ],
  },
  {
    metric: "creator.disputeRate",
    description: "disputed collaborations / submissions",
    numerator: ["content_disputed"],
    denominator: ["content_submitted"],
    perEntity: true,
  },
  {
    metric: "creator.timeToStartWork",
    description: "time from acceptance to work_started",
    numerator: ["work_started"],
    denominator: ["invite_accepted"],
    perEntity: true,
  },
  {
    metric: "creator.timeToRespond",
    description: "time from invite to accept/decline",
    numerator: ["invite_accepted", "invite_declined"],
    denominator: ["creator_invited"],
    perEntity: true,
    knownLimitations: [
      "Stage 2B flags a known accept-timestamp issue on some backfilled invites.",
    ],
  },
  {
    metric: "creator.counterOfferRate",
    description: "invites with a counter offer / invites received",
    numerator: ["counter_offer_sent"],
    denominator: ["creator_invited"],
    perEntity: true,
  },
  {
    metric: "creator.counterOfferAcceptance",
    description: "accepted counter offers / counter offers",
    numerator: [],
    denominator: ["counter_offer_sent"],
    perEntity: true,
    untrackedEvents: ["counter_offer_accepted", "counter_offer_declined"],
  },
  {
    metric: "owner.paymentReliability",
    description: "payments completed / approved deliveries (brand side)",
    numerator: ["payment_completed"],
    denominator: ["content_approved"],
    perEntity: true,
  },
  {
    metric: "platform.inviteFunnel",
    description:
      "platform-wide invite → accept → submit → approve → pay funnel",
    numerator: [
      "invite_accepted",
      "content_submitted",
      "content_approved",
      "payment_completed",
    ],
    denominator: ["creator_invited"],
    perEntity: false,
    knownLimitations: [
      "Already reported descriptively by Stage 2B (/api/admin/platform-metrics).",
    ],
  },
];

export type MetricReadiness = "READY" | "READY_WITH_CAVEAT" | "NOT_READY";

export function derivedMetricReadiness(
  input: ReadinessInput,
  coverageRows = eventCoverage(input),
) {
  const byType = new Map<string, (typeof coverageRows)[number]>(
    coverageRows.map((r) => [r.eventType, r]),
  );
  const known = new Set<string>(PLATFORM_EVENT_TYPES as readonly string[]);
  return DERIVED_METRICS.map((m) => {
    const blockers: string[] = [];
    const caveats: string[] = [...(m.knownLimitations ?? [])];
    const required = [...new Set([...m.numerator, ...m.denominator])];

    for (const e of m.untrackedEvents ?? []) {
      blockers.push(`'${e}' is not a recorded event type.`);
    }
    for (const e of required) {
      if (!known.has(e)) {
        blockers.push(`'${e}' is not a recorded event type.`);
        continue;
      }
      const row = byType.get(e);
      if (!row) continue;
      if (row.status === "missing_for_known_outcomes") {
        blockers.push(
          `'${e}': ${row.invitesImplyingEvent} invite(s) are in a state that implies it, but 0 events were recorded.`,
        );
      } else if (row.status === "incomplete") {
        const ratio = row.total / (row.invitesImplyingEvent || 1);
        (ratio < 0.5 ? blockers : caveats).push(
          `'${e}': ${row.total} event(s) for ${row.invitesImplyingEvent} invite(s) that imply it.`,
        );
      } else if (row.total === 0) {
        blockers.push(`'${e}': no events recorded yet.`);
      }
      if (row.total > 0 && (row.liveSharePct ?? 0) < 50) {
        caveats.push(
          `'${e}': ${row.liveSharePct}% live — mostly backfilled history.`,
        );
      }
    }

    const denominatorTotal = m.denominator.reduce(
      (sum, e) => sum + (byType.get(e)?.total ?? 0),
      0,
    );
    if (denominatorTotal > 0 && denominatorTotal < MIN_SAMPLE_SIZE) {
      caveats.push(
        `Only ${denominatorTotal} denominator event(s) platform-wide (< ${MIN_SAMPLE_SIZE}).`,
      );
    }
    if (m.perEntity && input.invitesPerCreator.atLeastMinSample === 0) {
      caveats.push(
        `No creator has ${MIN_SAMPLE_SIZE}+ invites (median ${input.invitesPerCreator.median}, max ${input.invitesPerCreator.max}) — per-creator rates would be noise.`,
      );
    }

    const readiness: MetricReadiness = blockers.length
      ? "NOT_READY"
      : caveats.length
        ? "READY_WITH_CAVEAT"
        : "READY";
    return {
      metric: m.metric,
      description: m.description,
      perEntity: m.perEntity,
      requiredEvents: required,
      readiness,
      blockers,
      caveats,
      eventQuality: {
        timestamps: "every platform_event has a server timestamp",
        duplicates: "prevented by the unique partial dedupeKey index (Stage 1)",
        stableIds: "inviteId / campaignId / actor ids on every event",
        sequence:
          "Stage 2A reports out-of-order anomalies (/api/admin/platform-data-quality)",
      },
    };
  });
}

// ── Normalization ─────────────────────────────────────────────────────────

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export interface NormalizationAudit {
  field: string;
  kind: "enum" | "master_list" | "canonical_resolver" | "free_text";
  distinctValues: number;
  emptyOrNull: number;
  /** Values outside the canonical/master set. */
  nonCanonical: ValueCount[];
  /** Different spellings that collapse to the same value (case/spacing or same canonical key). */
  spellingVariants: string[][];
  /** null = nothing stored to judge (field unused / not collected). */
  canonical: boolean | null;
  notes: string;
}

function auditField(
  field: string,
  values: ValueCount[] | undefined,
  opts: {
    kind: NormalizationAudit["kind"];
    canonicalSet?: string[];
    keyOf?: (v: string) => string | null;
    notes?: string;
  },
): NormalizationAudit {
  const rows = values ?? [];
  const present = rows.filter(
    (r) => r.value !== null && String(r.value).trim() !== "",
  );
  const emptyOrNull = rows
    .filter((r) => r.value === null || String(r.value).trim() === "")
    .reduce((s, r) => s + r.count, 0);

  const canonical = opts.canonicalSet ? new Set(opts.canonicalSet) : null;
  const nonCanonical =
    opts.kind === "free_text"
      ? []
      : present.filter((r) => {
          const v = String(r.value);
          if (opts.keyOf) return opts.keyOf(v) === null;
          return canonical ? !canonical.has(v) : false;
        });

  const groups = new Map<string, Set<string>>();
  for (const r of present) {
    const v = String(r.value);
    const key = opts.keyOf?.(v) ?? norm(v);
    const set = groups.get(key) ?? new Set<string>();
    set.add(v);
    groups.set(key, set);
  }
  const spellingVariants = [...groups.values()]
    .filter((s) => s.size > 1)
    .map((s) => [...s].sort());

  return {
    field,
    kind: opts.kind,
    distinctValues: present.length,
    emptyOrNull,
    nonCanonical,
    spellingVariants,
    canonical:
      opts.kind === "free_text"
        ? false
        : present.length === 0
          ? null
          : !nonCanonical.length && !spellingVariants.length,
    notes: opts.notes ?? "",
  };
}

const platformKeyOrNull = (v: string) => {
  const key = derivePlatformKey(v);
  return isKnownPlatformKey(key) ? key : null;
};
const tierKeyOrNull = (v: string) => resolveTier(v)?.key ?? null;

export function normalizationAudit(
  input: ReadinessInput,
): NormalizationAudit[] {
  const d = input.distinct;
  const m = input.masters;
  return [
    auditField("creator.socialMedia.platform", d["creator.platform"], {
      kind: "canonical_resolver",
      keyOf: platformKeyOrNull,
      notes: "Display names resolve to platformKey (3A-0).",
    }),
    auditField("campaign.platforms", d["campaign.platforms"], {
      kind: "canonical_resolver",
      keyOf: platformKeyOrNull,
      notes: "Stored as display names; no platformKey on campaigns.",
    }),
    auditField("creator.socialMedia.tier", d["creator.tier"], {
      kind: "canonical_resolver",
      keyOf: tierKeyOrNull,
      notes: `Canonical: ${CANONICAL_TIERS.map((t) => t.label).join(", ")}.`,
    }),
    auditField("campaign.minInfluencerTier", d["campaign.minInfluencerTier"], {
      kind: "canonical_resolver",
      keyOf: tierKeyOrNull,
    }),
    auditField("creator.contentTypes.name", d["creator.contentType"], {
      kind: "master_list",
      canonicalSet: m.contentTypes,
      notes: "Compared with the social-media master content types.",
    }),
    auditField("campaign.contentTypes.name", d["campaign.contentType"], {
      kind: "master_list",
      canonicalSet: m.contentTypes,
    }),
    auditField("creator.categories", d["creator.categories"], {
      kind: "master_list",
      canonicalSet: m.categories,
    }),
    auditField("campaign.categories", d["campaign.categories"], {
      kind: "master_list",
      canonicalSet: m.categories,
    }),
    auditField("creator.languages", d["creator.languages"], {
      kind: "master_list",
      canonicalSet: m.languages,
    }),
    auditField("creator.location.state", d["creator.state"], {
      kind: "master_list",
      canonicalSet: m.states,
    }),
    auditField("creator.location.country", d["creator.country"], {
      kind: "master_list",
      canonicalSet: [],
      notes: "Not collected.",
    }),
    auditField("campaign.deliverables", d["campaign.deliverables"], {
      kind: "free_text",
      notes: "Free text; use campaign content types for structured matching.",
    }),
    auditField("campaign.status", d["campaign.status"], {
      kind: "enum",
      canonicalSet: [
        "draft",
        "pending",
        "pending_review",
        "needs_changes",
        "active",
        "rejected",
        "completed",
        "cancelled",
      ],
    }),
  ];
}

// ── Report ────────────────────────────────────────────────────────────────

export function buildReadinessReport(input: ReadinessInput) {
  const creatorSignals = CREATOR_SIGNALS.map((s) => signalRow(s, input));
  const brandSignals = BRAND_SIGNALS.map((s) => signalRow(s, input));
  const campaignRecords = input.coverage.campaign?.records ?? 0;
  const campaignSignals = CAMPAIGN_REQUIREMENTS.map((r) => {
    const present = r.coverageField
      ? (input.coverage.campaign?.fields?.[r.coverageField] ?? 0)
      : null;
    return {
      ...r,
      availability: !r.stored
        ? "MISSING"
        : present === null
          ? "AVAILABLE"
          : availabilityFor(present, campaignRecords),
      coverage:
        present === null
          ? null
          : {
              present,
              of: campaignRecords,
              pct: pct(present, campaignRecords),
            },
    };
  });

  const coverageRows = eventCoverage(input);
  const metrics = derivedMetricReadiness(input, coverageRows);
  const normalization = normalizationAudit(input);

  const gap = (priority: "critical" | "important" | "optional") => [
    ...creatorSignals
      .filter(
        (s) =>
          s.priority === priority &&
          s.availability !== "AVAILABLE" &&
          s.availability !== "DERIVED",
      )
      .map((s) => ({
        signal: s.signal,
        availability: s.availability,
        why: s.notes,
      })),
    ...campaignSignals
      .filter((r) => r.priority === priority && r.availability !== "AVAILABLE")
      .map((r) => ({
        signal: `campaign.${r.requirement}`,
        availability: r.availability,
        why: r.notes,
      })),
  ];

  const missingData = {
    critical: gap("critical"),
    important: gap("important"),
    optional: gap("optional"),
  };
  const nonCanonicalFields = normalization.filter((n) => n.canonical === false);

  return {
    generatedAt: input.generatedAt.toISOString(),
    readOnly: true,
    summary: {
      verdict: missingData.critical.length
        ? "NOT READY for deterministic matching — critical gaps listed in missingData.critical."
        : "Foundation ready for rule-based matching on the AVAILABLE signals; history-based signals follow derivedMetricReadiness.",
      creators: input.creatorActivity.creators,
      campaigns: input.campaignVolume.total,
      caveats: [
        ...(input.campaignVolume.total < MIN_SAMPLE_SIZE
          ? [
              `Only ${input.campaignVolume.total} campaigns exist (< ${MIN_SAMPLE_SIZE}): campaign-requirement coverage reflects very little usage.`,
            ]
          : []),
        ...(metrics.every((m) => m.readiness !== "READY")
          ? [
              "No history-based metric is READY yet — a first matcher should rely on profile and campaign signals only.",
            ]
          : []),
      ],
      criticalGaps: missingData.critical.length,
      importantGaps: missingData.important.length,
      nonCanonicalFields: nonCanonicalFields.map((n) => n.field),
      derivedMetrics: {
        ready: metrics.filter((m) => m.readiness === "READY").length,
        readyWithCaveat: metrics.filter(
          (m) => m.readiness === "READY_WITH_CAVEAT",
        ).length,
        notReady: metrics.filter((m) => m.readiness === "NOT_READY").length,
      },
      signalCategories: SIGNAL_CATEGORIES,
    },
    creatorSignals,
    brandSignals,
    campaignSignals,
    campaignVolume: input.campaignVolume,
    creatorActivity: {
      ...input.creatorActivity,
      lastLogin30dPct: pct(
        input.creatorActivity.lastLogin30d,
        input.creatorActivity.creators,
      ),
      lastLogin90dPct: pct(
        input.creatorActivity.lastLogin90d,
        input.creatorActivity.creators,
      ),
    },
    historicalSignals: {
      events: coverageRows,
      inviteStatusCounts: input.inviteStatusCounts,
      invitesPerCreator: input.invitesPerCreator,
      note: "Event coverage is cross-checked against current invite statuses; details of sequencing and cohorts are in Stage 2A.",
    },
    derivedMetricReadiness: metrics,
    normalizationIssues: normalization,
    missingData,
    currentSearchAndRanking: SEARCH_AND_RANKING,
    dataConfidenceSemantics: DATA_CONFIDENCE_SEMANTICS,
    futureMatchingContract: FUTURE_MATCHING_CONTRACT,
  };
}
