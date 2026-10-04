import { NormalizedCampaignMatchInput } from "../matching-inputs/matching-inputs";
import {
  EligibilityResult,
  RequirementStatus,
  aggregateOverall,
} from "./eligibility";

/**
 * Stage 3B-3 — campaign → creator eligibility list (pure).
 *
 * Takes per-creator Stage 3B-2 results for one campaign and groups them by
 * overall status with per-requirement counts, filters and pagination.
 *
 * Grouping, not ranking: rows are ordered PASS → UNKNOWN → FAIL, then by name
 * and id. No scores, no weights, no TrendScore, no AI, nothing written.
 */

export const REQUIREMENT_KEYS = [
  "accountApproval",
  "creatorType",
  "platformContent",
  "category",
  "minimumTier",
  "location",
  "language",
] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export const OVERALL_STATUSES: RequirementStatus[] = [
  "PASS",
  "UNKNOWN",
  "FAIL",
];
const DEFAULT_STATUSES: RequirementStatus[] = ["PASS", "UNKNOWN"];
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface CreatorDisplay {
  name: string;
  username: string;
  publicId: string;
}

export interface CampaignEligibilityRow extends CreatorDisplay {
  creatorId: string;
  creatorType: EligibilityResult["creatorType"];
  overall: RequirementStatus;
  requirements: Record<
    RequirementKey,
    { status: RequirementStatus; reason: string; configured: boolean }
  >;
  /** Already holds an invite for this campaign (any status). Separate from eligibility. */
  invited: boolean;
  /**
   * Decided here, not in the browser: campaign accepts invites AND overall
   * PASS AND not already invited. Re-checked again at send time.
   */
  invitable: boolean;
  inviteBlockedReason: string | null;
}

export interface CampaignInviteWindow {
  open: boolean;
  reason: string | null;
}

/** Whether the campaign can take new admin invites right now (status + acceptance deadline). */
export function campaignInviteWindow(
  campaign: NormalizedCampaignMatchInput,
  now: Date = new Date(),
): CampaignInviteWindow {
  if (campaign.status.toLowerCase() !== "active")
    return {
      open: false,
      reason: "Invites can only be sent for live (approved) campaigns.",
    };
  const deadline = campaign.dates.acceptanceDeadline;
  if (deadline && deadline.getTime() < now.getTime())
    return {
      open: false,
      reason: "Campaign acceptance is closed by deadline.",
    };
  return { open: true, reason: null };
}

/** Why a row can't be invited (null = it can). */
export function inviteBlockedReason(
  row: Pick<CampaignEligibilityRow, "overall" | "invited">,
  window: CampaignInviteWindow,
): string | null {
  if (row.invited) return "Already invited to this campaign.";
  if (!window.open) return window.reason;
  if (row.overall === "FAIL") return "Not eligible.";
  if (row.overall === "UNKNOWN")
    return "Eligibility unknown — some requirements can't be checked.";
  return null;
}

export interface CampaignEligibilityQuery {
  statuses: RequirementStatus[];
  /** Only rows where this requirement is not PASS (FAIL or UNKNOWN). */
  requirement: RequirementKey | null;
  search: string;
  page: number;
  pageSize: number;
}

type Counts = Record<RequirementStatus, number>;
const zero = (): Counts => ({ PASS: 0, UNKNOWN: 0, FAIL: 0 });

export interface CampaignEligibilityList {
  campaign: {
    campaignId: string;
    title: string;
    status: string;
    /** Campaign-level invite window (status + acceptance deadline). */
    invitesOpen: boolean;
    invitesClosedReason: string | null;
    recipientRole: NormalizedCampaignMatchInput["recipientRole"];
    ownerType: NormalizedCampaignMatchInput["ownerType"];
    /** The campaign's configured requirements, as normalized in Stage 3B-1 (for display). */
    requirements: {
      platforms: string[];
      contentTypes: string[];
      categories: string[];
      targetCreatorCategories: string[];
      minimumTier: string | null;
      location: { state: string | null; district: string | null };
      languages: string[];
    };
  };
  /** Which creators were evaluated (the campaign's recipient type, not deleted). */
  scope: {
    creatorType: EligibilityResult["creatorType"];
    evaluated: number;
    alreadyInvited: number;
  };
  /** Overall counts across every evaluated creator (unfiltered). */
  counts: Counts;
  /** Per-requirement counts across every evaluated creator (unfiltered). */
  requirementCounts: Record<RequirementKey, Counts & { configured: boolean }>;
  query: CampaignEligibilityQuery;
  total: number;
  rows: CampaignEligibilityRow[];
  notEvaluated: EligibilityResult["notEvaluated"];
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const firstText = (v: unknown): string => {
  const f = first(v);
  return typeof f === "string" ? f.trim() : "";
};

function positiveInt(v: unknown, fallback: number, max?: number): number {
  const n = Number(first(v));
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max ? Math.min(n, max) : n;
}

/** Lenient query parsing: unknown values fall back to defaults, never throw. */
export function parseCampaignEligibilityQuery(
  raw: Record<string, unknown> = {},
): CampaignEligibilityQuery {
  const statusText = firstText(raw.status);
  const statuses =
    statusText.toLowerCase() === "all"
      ? [...OVERALL_STATUSES]
      : OVERALL_STATUSES.filter((s) =>
          statusText
            .split(",")
            .map((x) => x.trim().toUpperCase())
            .includes(s),
        );
  const requirement = firstText(raw.requirement);
  return {
    statuses: statuses.length ? statuses : [...DEFAULT_STATUSES],
    requirement: (REQUIREMENT_KEYS as readonly string[]).includes(requirement)
      ? (requirement as RequirementKey)
      : null,
    search: firstText(raw.q).slice(0, 100),
    page: positiveInt(raw.page, 1),
    pageSize: positiveInt(raw.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

export function toEligibilityRow(
  result: EligibilityResult,
  display: CreatorDisplay,
  invited = false,
): CampaignEligibilityRow {
  const requirements = {} as CampaignEligibilityRow["requirements"];
  for (const key of REQUIREMENT_KEYS) {
    const r = result.requirements[key];
    requirements[key] = {
      status: r.status,
      reason: r.reason,
      configured: r.configured,
    };
  }
  return {
    creatorId: result.creatorId,
    creatorType: result.creatorType,
    ...display,
    // Re-derived so the row can never disagree with its own requirements.
    overall: aggregateOverall(Object.values(requirements)),
    requirements,
    invited,
    // Filled in by buildCampaignEligibilityList, which knows the campaign window.
    invitable: false,
    inviteBlockedReason: null,
  };
}

const statusOrder = (s: RequirementStatus) => OVERALL_STATUSES.indexOf(s);

function compareRows(a: CampaignEligibilityRow, b: CampaignEligibilityRow) {
  return (
    statusOrder(a.overall) - statusOrder(b.overall) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.creatorId.localeCompare(b.creatorId)
  );
}

function matchesSearch(row: CampaignEligibilityRow, search: string) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [row.name, row.username, row.publicId, row.creatorId].some((v) =>
    v.toLowerCase().includes(needle),
  );
}

export function buildCampaignEligibilityList(
  campaign: NormalizedCampaignMatchInput,
  campaignTitle: string,
  creatorType: EligibilityResult["creatorType"],
  evaluatedRows: CampaignEligibilityRow[],
  query: CampaignEligibilityQuery,
  notEvaluated: EligibilityResult["notEvaluated"],
  now: Date = new Date(),
): CampaignEligibilityList {
  const window = campaignInviteWindow(campaign, now);
  const rows = evaluatedRows.map((row) => {
    const blocked = inviteBlockedReason(row, window);
    return {
      ...row,
      invitable: blocked === null,
      inviteBlockedReason: blocked,
    };
  });
  const counts = zero();
  const requirementCounts = {} as CampaignEligibilityList["requirementCounts"];
  for (const key of REQUIREMENT_KEYS)
    requirementCounts[key] = { ...zero(), configured: false };
  for (const row of rows) {
    counts[row.overall]++;
    for (const key of REQUIREMENT_KEYS) {
      const r = row.requirements[key];
      requirementCounts[key][r.status]++;
      if (r.configured) requirementCounts[key].configured = true;
    }
  }

  const filtered = rows
    .filter((r) => query.statuses.includes(r.overall))
    .filter(
      (r) =>
        !query.requirement ||
        r.requirements[query.requirement].status !== "PASS",
    )
    .filter((r) => matchesSearch(r, query.search))
    .sort(compareRows);
  const start = (query.page - 1) * query.pageSize;

  return {
    campaign: {
      campaignId: campaign.campaignId,
      title: campaignTitle,
      status: campaign.status,
      invitesOpen: window.open,
      invitesClosedReason: window.reason,
      recipientRole: campaign.recipientRole,
      ownerType: campaign.ownerType,
      requirements: {
        platforms: campaign.platforms
          .map((p) => p.platformKey ?? p.original)
          .filter(Boolean),
        contentTypes: campaign.contentTypes,
        categories: campaign.categories,
        targetCreatorCategories: campaign.targetCreatorCategories,
        minimumTier: campaign.minimumTier?.label ?? null,
        location: {
          state: campaign.location.state,
          district: campaign.location.district,
        },
        languages: campaign.languages,
      },
    },
    scope: {
      creatorType,
      evaluated: rows.length,
      alreadyInvited: rows.filter((r) => r.invited).length,
    },
    counts,
    requirementCounts,
    query,
    total: filtered.length,
    rows: filtered.slice(start, start + query.pageSize),
    notEvaluated,
  };
}
