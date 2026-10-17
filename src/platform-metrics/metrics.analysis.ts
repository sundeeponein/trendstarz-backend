import {
  PLATFORM_EVENT_COHORTS,
  cohortStart,
} from "../platform-events/platform-event-coverage";
import {
  kolkataWindows,
  TimeWindow,
  WindowKey,
} from "../platform-data-quality/kolkata-windows";
import {
  CampaignRecord,
  DurationStats,
  InviteJourney,
  JourneyData,
  Rate,
  Step,
} from "./metrics.types";

/**
 * Stage 2B — descriptive marketplace metrics. Pure functions over invite
 * journeys (one row per invite) and campaign records; no database access.
 *
 * Rules carried over from Stage 2A:
 *  - Steps without backfilled history (view, decline, counter-offer, work start,
 *    dispute) only count invites whose LIVE creator_invited is at/after the
 *    boundary of the stage that started recording them.
 *  - campaign_completed is campaign-level; a creator collaboration is complete on
 *    content_approved unless a later rejection/dispute reverses it.
 *  - Creator = influencerId + recipientRole; owner = brandId + owner type;
 *    userId (the actor) is never used as either.
 *  - No rankings: lists are ordered by id, and every rate below MIN_SAMPLE_SIZE is
 *    null with status insufficient_data.
 */

export const MIN_SAMPLE_SIZE = 20;
export const WINDOW_KEYS = [
  "today",
  "yesterday",
  "last7Days",
  "last30Days",
  "monthToDate",
  "all",
] as const;
export type MetricsWindow = (typeof WINDOW_KEYS)[number];

const STAGE1 = cohortStart(PLATFORM_EVENT_COHORTS.stage1);
const STAGE15 = cohortStart(PLATFORM_EVENT_COHORTS.stage15);
const HOUR_MS = 3600_000;

// ── Primitives ──────────────────────────────────────────────────────────────

export function rate(
  numerator: number,
  denominator: number,
  min = MIN_SAMPLE_SIZE,
): Rate {
  const ok = denominator >= min && denominator > 0;
  return {
    numerator,
    denominator,
    sampleSize: denominator,
    rate: ok ? Math.round((numerator / denominator) * 10000) / 10000 : null,
    status: ok ? "ok" : "insufficient_data",
  };
}

export function resolveWindow(
  key: MetricsWindow,
  now: Date,
): TimeWindow | null {
  return key === "all" ? null : kolkataWindows(now)[key as WindowKey];
}

function inWindow(at: Date | null, w: TimeWindow | null): boolean {
  if (!at) return false;
  if (!w) return true;
  const t = new Date(at).getTime();
  return t >= w.from.getTime() && t < w.to.getTime();
}

const has = (s: Step) => !!s.at;
const after = (a: Step, b: Step) =>
  has(a) && has(b) && new Date(a.at as Date) > new Date(b.at as Date);
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** Entry into the marketplace funnel: an owner invite, else a creator application. */
export function entryStep(j: InviteJourney): Step {
  return has(j.invited) ? j.invited : j.applied;
}

/** Live creator_invited at or after `boundary` — the cohort for non-backfillable steps. */
function inLiveCohort(j: InviteJourney, boundary: Date): boolean {
  return (
    j.invited.source === "live" &&
    has(j.invited) &&
    new Date(j.invited.at as Date) >= boundary
  );
}

export function isReversed(j: InviteJourney): boolean {
  return (
    has(j.approved) &&
    (after(j.rejected, j.approved) || after(j.lastDisputed, j.approved))
  );
}

export function isCompleted(j: InviteJourney): boolean {
  return has(j.approved) && !isReversed(j);
}

/** Pre-fix owner counter acceptances carry the counter-SEND time (Stage 2A known issue). */
export function hasKnownAcceptTimestampIssue(j: InviteJourney): boolean {
  return (
    has(j.accepted) &&
    has(j.counterSent) &&
    new Date(j.accepted.at as Date) < new Date(j.counterSent.at as Date)
  );
}

export function durations(
  journeys: InviteJourney[],
  from: (j: InviteJourney) => Step,
  to: (j: InviteJourney) => Step,
  min = MIN_SAMPLE_SIZE,
): DurationStats {
  const hours: number[] = [];
  let derivedPairs = 0;
  for (const j of journeys) {
    const a = from(j);
    const b = to(j);
    if (!has(a) || !has(b)) continue;
    const diff =
      new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime();
    if (diff < 0) continue; // out-of-order timestamps are a data-quality issue, not a duration
    hours.push(diff / HOUR_MS);
    if (a.source === "backfill" || b.source === "backfill") derivedPairs += 1;
  }
  hours.sort((x, y) => x - y);
  const ok = hours.length >= min;
  const mid = Math.floor(hours.length / 2);
  const median =
    hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    sampleSize: hours.length,
    medianHours: ok ? round(median) : null,
    averageHours: ok
      ? round(hours.reduce((s, h) => s + h, 0) / hours.length)
      : null,
    derivedPairs,
    status: ok ? "ok" : "insufficient_data",
  };
}

// ── Attribution (who / which mode) ──────────────────────────────────────────

export function resolveRole(j: InviteJourney): {
  role: "influencer" | "photographer";
  roleSource: "event" | "legacy_default";
} {
  if (j.recipientRole === "photographer")
    return { role: "photographer", roleSource: "event" };
  if (j.recipientRole === "influencer")
    return { role: "influencer", roleSource: "event" };
  // Invites created before recipientRole existed are influencer invites (the app's own convention).
  return { role: "influencer", roleSource: "legacy_default" };
}

type Sourced<T> = {
  value: T | null;
  source: "event" | "current_campaign_state" | "unavailable";
};

export function resolveCampaignMode(
  j: InviteJourney | null,
  campaign: CampaignRecord | undefined,
): Sourced<string> {
  if (j?.eventCampaignMode)
    return { value: j.eventCampaignMode, source: "event" };
  if (campaign?.eventCampaignMode)
    return { value: campaign.eventCampaignMode, source: "event" };
  if (campaign?.current?.campaignMode)
    return {
      value: campaign.current.campaignMode,
      source: "current_campaign_state",
    };
  return { value: null, source: "unavailable" };
}

export function resolveOwnerType(
  campaign: CampaignRecord | undefined,
): Sourced<"brand" | "photographer"> {
  const norm = (v: string | null | undefined) =>
    v === "photographer" ? "photographer" : v ? "brand" : null;
  if (campaign?.eventOwnerType)
    return { value: norm(campaign.eventOwnerType), source: "event" };
  if (campaign?.current?.ownerType)
    return {
      value: norm(campaign.current.ownerType),
      source: "current_campaign_state",
    };
  return { value: null, source: "unavailable" };
}

function resolveCampaignType(
  campaign: CampaignRecord | undefined,
): Sourced<string> {
  if (campaign?.eventCampaignType)
    return { value: campaign.eventCampaignType, source: "event" };
  if (campaign?.current?.campaignType)
    return {
      value: campaign.current.campaignType,
      source: "current_campaign_state",
    };
  return { value: null, source: "unavailable" };
}

// ── Counts shared by every grouping ─────────────────────────────────────────

export function countSteps(js: InviteJourney[]) {
  const n = (pred: (j: InviteJourney) => boolean) => js.filter(pred).length;
  const withdrawnByReason: Record<string, number> = {};
  for (const j of js) {
    if (!has(j.withdrawn)) continue;
    const key = j.withdrawnReason || "unclassified";
    withdrawnByReason[key] = (withdrawnByReason[key] || 0) + 1;
  }
  return {
    invitations: n((j) => has(j.invited)),
    applications: n((j) => has(j.applied)),
    accepted: n((j) => has(j.accepted)),
    submitted: n((j) => has(j.submitted)),
    approved: n((j) => has(j.approved)),
    rejected: n((j) => has(j.rejected)),
    completedCollaborations: n(isCompleted),
    reversedApprovals: n(isReversed),
    withdrawn: n((j) => has(j.withdrawn)),
    withdrawnByReason,
    // Cohort-limited steps: counted only inside the cohort that could record them.
    viewedSinceStage1: n((j) => inLiveCohort(j, STAGE1) && has(j.viewed)),
    declinedSinceStage1: n((j) => inLiveCohort(j, STAGE1) && has(j.declined)),
    counterOffersSinceStage15: n(
      (j) => inLiveCohort(j, STAGE15) && has(j.counterSent),
    ),
    workStartedSinceStage15: n(
      (j) => inLiveCohort(j, STAGE15) && has(j.workStarted),
    ),
    disputedSinceStage15: n(
      (j) => inLiveCohort(j, STAGE15) && has(j.firstDisputed),
    ),
    collections: n((j) => has(j.collection)),
    payouts: n((j) => has(j.payout)),
    collectedPaise: js.reduce(
      (s, j) => s + (has(j.collection) ? Number(j.collectionPaise || 0) : 0),
      0,
    ),
    paidOutPaise: js.reduce(
      (s, j) => s + (has(j.payout) ? Number(j.payoutPaise || 0) : 0),
      0,
    ),
  };
}

function coreRates(js: InviteJourney[]) {
  const invitedAll = js.filter((j) => has(j.invited));
  const accepted = js.filter((j) => has(j.accepted));
  const submitted = js.filter((j) => has(j.submitted));
  return {
    inviteAcceptance: rate(
      invitedAll.filter((j) => has(j.accepted)).length,
      invitedAll.length,
    ),
    submissionAfterAcceptance: rate(
      accepted.filter((j) => has(j.submitted)).length,
      accepted.length,
    ),
    approvalOfSubmissions: rate(
      submitted.filter((j) => has(j.approved)).length,
      submitted.length,
    ),
    completionAfterAcceptance: rate(
      accepted.filter(isCompleted).length,
      accepted.length,
    ),
  };
}

// ── Funnels ─────────────────────────────────────────────────────────────────

type Basis = "all_history" | "since_stage1" | "since_stage15";

function funnelStep(
  js: InviteJourney[],
  step: string,
  basis: Basis,
  parent: (j: InviteJourney) => boolean,
  reached: (j: InviteJourney) => boolean,
) {
  const inBasis =
    basis === "all_history"
      ? (j: InviteJourney) => has(j.invited)
      : (j: InviteJourney) =>
          inLiveCohort(j, basis === "since_stage1" ? STAGE1 : STAGE15);
  const eligible = js.filter((j) => inBasis(j) && parent(j));
  const count = eligible.filter(reached).length;
  return {
    step,
    basis,
    eligible: eligible.length,
    count,
    rateOfEligible: rate(count, eligible.length),
  };
}

export function inviteOnlyFunnel(js: InviteJourney[]) {
  const top = () => true;
  const acc = (j: InviteJourney) => has(j.accepted);
  const sub = (j: InviteJourney) => has(j.submitted);
  const excludeKnown = js.filter((j) => !hasKnownAcceptTimestampIssue(j));
  return {
    invites: js.filter((j) => has(j.invited)).length,
    steps: [
      funnelStep(js, "invite_viewed", "since_stage1", top, (j) =>
        has(j.viewed),
      ),
      funnelStep(js, "invite_declined", "since_stage1", top, (j) =>
        has(j.declined),
      ),
      funnelStep(js, "counter_offer_sent", "since_stage15", top, (j) =>
        has(j.counterSent),
      ),
      funnelStep(js, "invite_accepted", "all_history", top, acc),
      funnelStep(js, "work_started", "since_stage15", acc, (j) =>
        has(j.workStarted),
      ),
      funnelStep(js, "content_submitted", "all_history", acc, sub),
      funnelStep(js, "content_disputed", "since_stage15", sub, (j) =>
        has(j.firstDisputed),
      ),
      funnelStep(js, "content_approved", "all_history", sub, (j) =>
        has(j.approved),
      ),
      funnelStep(
        js,
        "collaboration_completed",
        "all_history",
        acc,
        isCompleted,
      ),
      funnelStep(js, "payout_completed", "all_history", isCompleted, (j) =>
        has(j.payout),
      ),
      funnelStep(js, "invite_withdrawn", "all_history", top, (j) =>
        has(j.withdrawn),
      ),
    ],
    withdrawnByReason: countSteps(js).withdrawnByReason,
    timeToStep: {
      invitedToViewed: durations(
        js.filter((j) => inLiveCohort(j, STAGE1)),
        (j) => j.invited,
        (j) => j.viewed,
      ),
      invitedToAccepted: durations(
        excludeKnown,
        (j) => j.invited,
        (j) => j.accepted,
      ),
      acceptedToSubmitted: durations(
        excludeKnown,
        (j) => j.accepted,
        (j) => j.submitted,
      ),
      submittedToApproved: durations(
        js,
        (j) => j.submitted,
        (j) => j.approved,
      ),
      approvedToPayout: durations(
        js,
        (j) => j.approved,
        (j) => j.payout,
      ),
    },
    notes: [
      "all_history steps include derived backfill (source: backfill); since_stage1/since_stage15 steps only count invites whose live creator_invited is at/after that boundary.",
      "invites with the pre-fix invite_accepted timestamp are excluded from time-to-accept and accept-to-submit.",
    ],
  };
}

export function openCampaignFunnel(
  js: InviteJourney[],
  ownerInvitesOnOpen: number,
) {
  const apps = js.filter((j) => has(j.applied));
  const accepted = apps.filter((j) => has(j.accepted));
  const submitted = apps.filter((j) => has(j.submitted));
  return {
    applications: apps.length,
    steps: [
      {
        step: "invite_accepted",
        eligible: apps.length,
        count: accepted.length,
        rateOfEligible: rate(accepted.length, apps.length),
      },
      {
        step: "content_submitted",
        eligible: accepted.length,
        count: submitted.length,
        rateOfEligible: rate(submitted.length, accepted.length),
      },
      {
        step: "content_approved",
        eligible: submitted.length,
        count: submitted.filter((j) => has(j.approved)).length,
        rateOfEligible: rate(
          submitted.filter((j) => has(j.approved)).length,
          submitted.length,
        ),
      },
      {
        step: "collaboration_completed",
        eligible: accepted.length,
        count: accepted.filter(isCompleted).length,
        rateOfEligible: rate(
          accepted.filter(isCompleted).length,
          accepted.length,
        ),
      },
    ],
    timeToStep: {
      appliedToAccepted: durations(
        apps,
        (j) => j.applied,
        (j) => j.accepted,
      ),
    },
    ownerInvitesOnOpenCampaigns: ownerInvitesOnOpen,
    creatorSelected: "unavailable",
    notes: [
      "Applications exist only as live creator_applied events (Stage 1 onward); older open-campaign invite rows cannot be told apart from owner invites and are excluded.",
      "The creator accepts their own application — there is no owner selection step, so creator_selected is unavailable.",
    ],
  };
}

// ── Builders per endpoint ───────────────────────────────────────────────────

/** Journeys whose funnel entry falls in the window. */
export function journeysInWindow(
  data: JourneyData,
  key: MetricsWindow,
): InviteJourney[] {
  const w = resolveWindow(key, data.now);
  return data.journeys.filter((j) => inWindow(entryStep(j).at, w));
}

function splitByMode(data: JourneyData, js: InviteJourney[]) {
  const inviteOnly: InviteJourney[] = [];
  const open: InviteJourney[] = [];
  const unknown: InviteJourney[] = [];
  const modeSource = { event: 0, current_campaign_state: 0, unavailable: 0 };
  for (const j of js) {
    const mode = resolveCampaignMode(
      j,
      j.campaignId ? data.campaigns.get(j.campaignId) : undefined,
    );
    modeSource[mode.source] += 1;
    if (mode.value === "tier_filtered_open") open.push(j);
    else if (mode.value === "invite_only") inviteOnly.push(j);
    else unknown.push(j);
  }
  return { inviteOnly, open, unknown, modeSource };
}

export function buildOverview(
  data: JourneyData,
  key: MetricsWindow,
  activity: Array<{ eventType: string; source: string | null; count: number }>,
  activeCampaignsNow: number,
) {
  const w = resolveWindow(key, data.now);
  const js = journeysInWindow(data, key);
  const { inviteOnly, open, unknown, modeSource } = splitByMode(data, js);

  const activityByType: Record<
    string,
    { live: number; backfill: number; total: number }
  > = {};
  for (const a of activity) {
    const row = (activityByType[a.eventType] ||= {
      live: 0,
      backfill: 0,
      total: 0,
    });
    if (a.source === "backfill") row.backfill += a.count;
    else row.live += a.count;
    row.total += a.count;
  }

  const campaigns = [...data.campaigns.values()];
  const moneyInWindow = {
    unit: "paise",
    collected: data.journeys.reduce(
      (s, j) =>
        s + (inWindow(j.collection.at, w) ? Number(j.collectionPaise || 0) : 0),
      0,
    ),
    paidOut: data.journeys.reduce(
      (s, j) => s + (inWindow(j.payout.at, w) ? Number(j.payoutPaise || 0) : 0),
      0,
    ),
    note: "Collaboration money only (payment_completed events). Platform subscription payments are a separate domain.",
  };

  return {
    window: {
      key,
      from: iso(w?.from ?? null),
      to: iso(w?.to ?? null),
      timezone: "Asia/Kolkata",
    },
    minSampleSize: MIN_SAMPLE_SIZE,
    activity: {
      description:
        "Events whose timestamp falls in the window (live vs derived backfill kept apart).",
      byEventType: activityByType,
      campaignsCreated: campaigns.filter((c) => inWindow(c.created.at, w))
        .length,
      campaignsCompleted: campaigns.filter((c) => inWindow(c.completed.at, w))
        .length,
      activeCampaignsNow: {
        count: activeCampaignsNow,
        source: "current_campaign_state",
      },
      money: moneyInWindow,
    },
    cohort: {
      description:
        "Invites whose entry (invited / applied) falls in the window, followed to their outcome.",
      invites: js.length,
      // Invites with later steps but no creator_invited/creator_applied (e.g. their campaign
      // was deleted before backfill) can't enter any window, so they're counted here instead.
      invitesWithoutEntryEvent: data.journeys.filter((j) => !has(entryStep(j)))
        .length,
      campaignModeSource: modeSource,
      unknownModeInvites: unknown.length,
      totals: countSteps(js),
      rates: coreRates(inviteOnly),
    },
    inviteOnlyFunnel: inviteOnlyFunnel(inviteOnly),
    openCampaignFunnel: openCampaignFunnel(
      open,
      open.filter((j) => has(j.invited)).length,
    ),
    platformBreakdown: platformBreakdown(js),
  };
}

export function platformBreakdown(js: InviteJourney[]) {
  const groups = new Map<string, InviteJourney[]>();
  for (const j of js) {
    const p =
      String(j.platform || "")
        .trim()
        .toLowerCase() || "unknown";
    const key = p === "x" ? "twitter" : p;
    const list = groups.get(key) || [];
    list.push(j);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, list]) => {
      const c = countSteps(list);
      return {
        platform,
        invitations: c.invitations,
        applications: c.applications,
        accepted: c.accepted,
        submitted: c.submitted,
        approved: c.approved,
        completedCollaborations: c.completedCollaborations,
        inviteAcceptance: coreRates(list).inviteAcceptance,
      };
    });
}

function paginate<T>(rows: T[], limit: number, offset: number) {
  return {
    total: rows.length,
    limit,
    offset,
    rows: rows.slice(offset, offset + limit),
  };
}

export function buildCreatorMetrics(
  data: JourneyData,
  key: MetricsWindow,
  opts: { role?: "influencer" | "photographer"; limit: number; offset: number },
) {
  const groups = new Map<
    string,
    { role: string; roleSource: string; js: InviteJourney[] }
  >();
  for (const j of journeysInWindow(data, key)) {
    if (!j.creatorId) continue;
    const { role, roleSource } = resolveRole(j);
    if (opts.role && role !== opts.role) continue;
    const g = groups.get(`${role}:${j.creatorId}`) || {
      role,
      roleSource,
      js: [],
    };
    if (roleSource === "event") g.roleSource = "event";
    g.js.push(j);
    groups.set(`${role}:${j.creatorId}`, g);
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, g]) => ({
      creatorId: k.split(":")[1],
      recipientRole: g.role,
      recipientRoleSource: g.roleSource,
      sampleSize: g.js.length,
      counts: countSteps(g.js),
      rates: coreRates(g.js),
      timeToAccept: durations(
        g.js.filter((j) => !hasKnownAcceptTimestampIssue(j)),
        (j) => j.invited,
        (j) => j.accepted,
      ),
    }));
  return {
    window: key,
    minSampleSize: MIN_SAMPLE_SIZE,
    ordering: "by creatorId (not a ranking)",
    ...paginate(rows, opts.limit, opts.offset),
  };
}

export function buildOwnerMetrics(
  data: JourneyData,
  key: MetricsWindow,
  opts: { ownerType?: "brand" | "photographer"; limit: number; offset: number },
) {
  const w = resolveWindow(key, data.now);
  const groups = new Map<
    string,
    {
      ownerType: string | null;
      ownerTypeSource: string;
      js: InviteJourney[];
      campaigns: CampaignRecord[];
    }
  >();
  const groupFor = (ownerId: string, campaign: CampaignRecord | undefined) => {
    const t = resolveOwnerType(campaign);
    const g = groups.get(ownerId) || {
      ownerType: t.value,
      ownerTypeSource: t.source,
      js: [],
      campaigns: [],
    };
    if (!g.ownerType && t.value) {
      g.ownerType = t.value;
      g.ownerTypeSource = t.source;
    }
    groups.set(ownerId, g);
    return g;
  };
  for (const c of data.campaigns.values()) {
    if (c.ownerId && (inWindow(c.created.at, w) || inWindow(c.completed.at, w)))
      groupFor(c.ownerId, c).campaigns.push(c);
  }
  for (const j of journeysInWindow(data, key)) {
    if (!j.ownerId) continue;
    groupFor(
      j.ownerId,
      j.campaignId ? data.campaigns.get(j.campaignId) : undefined,
    ).js.push(j);
  }
  const rows = [...groups.entries()]
    .filter(([, g]) => !opts.ownerType || g.ownerType === opts.ownerType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ownerId, g]) => {
      const { inviteOnly, open } = splitByMode(data, g.js);
      return {
        ownerId,
        ownerType: g.ownerType ?? "unavailable",
        ownerTypeSource: g.ownerTypeSource,
        campaignsCreated: g.campaigns.filter((c) => inWindow(c.created.at, w))
          .length,
        campaignsCompleted: g.campaigns.filter((c) =>
          inWindow(c.completed.at, w),
        ).length,
        sampleSize: g.js.length,
        counts: countSteps(g.js),
        inviteOnly: {
          invitations: inviteOnly.filter((j) => has(j.invited)).length,
          rates: coreRates(inviteOnly),
        },
        openCampaigns: {
          applications: open.filter((j) => has(j.applied)).length,
          accepted: open.filter((j) => has(j.accepted)).length,
        },
      };
    });
  return {
    window: key,
    minSampleSize: MIN_SAMPLE_SIZE,
    ordering: "by ownerId (not a ranking)",
    note: "Campaign owners are brands OR photographers; owner type prefers the value recorded on campaign_created.",
    ...paginate(rows, opts.limit, opts.offset),
  };
}

export function buildCampaignMetrics(
  data: JourneyData,
  key: MetricsWindow,
  opts: { limit: number; offset: number },
) {
  const w = resolveWindow(key, data.now);
  const byCampaign = new Map<string, InviteJourney[]>();
  for (const j of data.journeys) {
    if (!j.campaignId) continue;
    const list = byCampaign.get(j.campaignId) || [];
    list.push(j);
    byCampaign.set(j.campaignId, list);
  }
  const rows = [...data.campaigns.values()]
    .filter((c) => (key === "all" ? true : inWindow(c.created.at, w)))
    .sort((a, b) => a.campaignId.localeCompare(b.campaignId))
    .map((c) => {
      const js = byCampaign.get(c.campaignId) || [];
      const mode = resolveCampaignMode(null, c);
      const type = resolveCampaignType(c);
      const owner = resolveOwnerType(c);
      const lifecycleHours =
        has(c.created) && has(c.completed)
          ? Math.round(
              ((new Date(c.completed.at as Date).getTime() -
                new Date(c.created.at as Date).getTime()) /
                HOUR_MS) *
                10,
            ) / 10
          : null;
      return {
        campaignId: c.campaignId,
        ownerId: c.ownerId,
        ownerType: owner.value ?? "unavailable",
        ownerTypeSource: owner.source,
        campaignMode: mode.value ?? "unavailable",
        campaignModeSource: mode.source,
        campaignType: type.value ?? "unavailable",
        campaignTypeSource: type.source,
        currentStatus: c.current?.status ?? "campaign_missing",
        createdAt: iso(c.created.at),
        createdSource: c.created.source,
        completedAt: iso(c.completed.at),
        completedBy: c.completedBy,
        lifecycleHours,
        counts: countSteps(js),
      };
    });
  return {
    window: key,
    windowAppliesTo:
      key === "all" ? "all campaigns with events" : "campaign creation time",
    ordering: "by campaignId",
    ...paginate(rows, opts.limit, opts.offset),
  };
}

export function buildRelationships(
  data: JourneyData,
  opts: {
    creatorId?: string;
    campaignId?: string;
    limit: number;
    offset: number;
  },
) {
  const stepOut = (s: Step) =>
    has(s) ? { at: iso(s.at), source: s.source } : null;
  const rows = data.journeys
    .filter(
      (j) =>
        (!opts.creatorId || j.creatorId === opts.creatorId) &&
        (!opts.campaignId || j.campaignId === opts.campaignId),
    )
    .sort((a, b) => a.inviteId.localeCompare(b.inviteId))
    .map((j) => {
      const campaign = j.campaignId
        ? data.campaigns.get(j.campaignId)
        : undefined;
      const mode = resolveCampaignMode(j, campaign);
      const type = resolveCampaignType(campaign);
      const { role, roleSource } = resolveRole(j);
      const outcome = isCompleted(j)
        ? "completed"
        : isReversed(j)
          ? "approval_reversed"
          : has(j.rejected)
            ? "rejected"
            : has(j.withdrawn)
              ? `withdrawn:${j.withdrawnReason || "unclassified"}`
              : has(j.declined)
                ? "declined"
                : "open_or_unknown";
      return {
        inviteId: j.inviteId,
        creatorId: j.creatorId,
        recipientRole: role,
        recipientRoleSource: roleSource,
        campaignId: j.campaignId,
        campaignMode: mode.value ?? "unavailable",
        campaignModeSource: mode.source,
        campaignType: type.value ?? "unavailable",
        platform: j.platform,
        entry: has(j.invited)
          ? "invited"
          : has(j.applied)
            ? "applied"
            : "unknown",
        steps: {
          invited: stepOut(j.invited),
          applied: stepOut(j.applied),
          viewed: stepOut(j.viewed),
          counterOffer: stepOut(j.counterSent),
          accepted: stepOut(j.accepted),
          declined: stepOut(j.declined),
          workStarted: stepOut(j.workStarted),
          submitted: stepOut(j.submitted),
          disputed: stepOut(j.firstDisputed),
          approved: stepOut(j.approved),
          rejected: stepOut(j.rejected),
          withdrawn: stepOut(j.withdrawn),
          collection: stepOut(j.collection),
          payout: stepOut(j.payout),
        },
        outcome,
        knownTimestampIssue: hasKnownAcceptTimestampIssue(j),
      };
    });
  return {
    description:
      "Raw creator↔campaign history for future matching work. No scores — a missing step means it did not happen OR was not recorded (see each step's cohort in the Stage 2A report).",
    ...paginate(rows, opts.limit, opts.offset),
  };
}

export function buildTimeSeries(
  key: MetricsWindow,
  now: Date,
  rows: Array<{
    bucket: string;
    eventType: string;
    source: string | null;
    count: number;
  }>,
) {
  const w = resolveWindow(key, now);
  const buckets = new Map<
    string,
    Record<string, { live: number; backfill: number }>
  >();
  for (const r of rows) {
    const b = buckets.get(r.bucket) || {};
    const cell = (b[r.eventType] ||= { live: 0, backfill: 0 });
    if (r.source === "backfill") cell.backfill += r.count;
    else cell.live += r.count;
    buckets.set(r.bucket, b);
  }
  return {
    window: { key, from: iso(w?.from ?? null), to: iso(w?.to ?? null) },
    bucket: key === "all" ? "month" : "day",
    timezone: "Asia/Kolkata",
    series: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, byEventType]) => ({ bucket, byEventType })),
  };
}

/** reliable ≥ 80%, sparse 20–80%, missing < 20% of records. */
export function coverageStatus(present: number, total: number) {
  const pct = total ? Math.round((present / total) * 1000) / 10 : 0;
  return {
    present,
    coveragePct: pct,
    status:
      total === 0
        ? "no_records"
        : pct >= 80
          ? "reliable"
          : pct >= 20
            ? "sparse"
            : "missing",
  };
}

export function buildAttributeCoverage(
  collections: Array<{
    entity: string;
    collection: string;
    total: number;
    fields: Record<string, number>;
  }>,
) {
  return {
    description:
      "How many current, non-deleted records have each matching-relevant attribute filled in. Descriptive only — no scoring.",
    thresholds: { reliable: ">= 80%", sparse: "20-80%", missing: "< 20%" },
    entities: collections.map((c) => ({
      entity: c.entity,
      collection: c.collection,
      records: c.total,
      fields: Object.entries(c.fields).map(([field, present]) => ({
        field,
        ...coverageStatus(present, c.total),
      })),
    })),
  };
}
