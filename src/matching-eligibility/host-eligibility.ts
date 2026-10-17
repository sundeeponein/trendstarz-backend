import { NormalizedCampaignMatchInput } from "../matching-inputs/matching-inputs";
import { REQUIREMENT_KEYS, RequirementKey } from "./campaign-eligibility";
import { EligibilityResult } from "./eligibility";

/**
 * Stage 3B-4 — the host-facing projection of Stage 3B-2 eligibility.
 *
 * Hosts see, per creator, whether the campaign's requirements are met and
 * WHICH requirements are not — as labels only. The admin reasons are never
 * sent: they quote creator data and, for account approval, private account
 * state. Creators who are not approved/active are left out entirely (they
 * cannot be invited anyway), so hosts learn nothing about unapproved accounts.
 *
 * Informational only: invites, applications and existing rules are unchanged.
 */

export type HostRequirementKey = Exclude<RequirementKey, "accountApproval">;

export const HOST_REQUIREMENT_LABELS: Record<HostRequirementKey, string> = {
  creatorType: "Creator type",
  platformContent: "Platform / content",
  category: "Category",
  minimumTier: "Tier",
  location: "Location",
  language: "Language",
};

const HOST_KEYS = REQUIREMENT_KEYS.filter(
  (k): k is HostRequirementKey => k !== "accountApproval",
);

export interface HostCreatorEligibility {
  /** meets: every configured requirement passes; not_met: at least one fails; needs_info: none fail, some can't be checked. */
  status: "meets" | "not_met" | "needs_info";
  notMet: string[];
  needsInfo: string[];
}

export interface HostEligibilityView {
  campaignId: string;
  /** False for photographer-recipient campaigns (not checkable yet) — show nothing. */
  supported: boolean;
  /** Labels of the requirements this campaign actually sets. */
  configured: string[];
  creators: Record<string, HostCreatorEligibility>;
}

export function toHostCreatorEligibility(
  result: EligibilityResult,
): HostCreatorEligibility {
  const notMet: string[] = [];
  const needsInfo: string[] = [];
  for (const key of HOST_KEYS) {
    const r = result.requirements[key];
    if (r.status === "FAIL") notMet.push(HOST_REQUIREMENT_LABELS[key]);
    else if (r.status === "UNKNOWN")
      needsInfo.push(HOST_REQUIREMENT_LABELS[key]);
  }
  return {
    status: notMet.length
      ? "not_met"
      : needsInfo.length
        ? "needs_info"
        : "meets",
    notMet,
    needsInfo,
  };
}

export function buildHostEligibilityView(
  campaign: NormalizedCampaignMatchInput,
  results: EligibilityResult[],
): HostEligibilityView {
  if (campaign.recipientRole === "photographer") {
    return {
      campaignId: campaign.campaignId,
      supported: false,
      configured: [],
      creators: {},
    };
  }
  const configured = new Set<HostRequirementKey>();
  const creators: Record<string, HostCreatorEligibility> = {};
  for (const result of results) {
    for (const key of HOST_KEYS)
      if (result.requirements[key].configured) configured.add(key);
    if (result.requirements.accountApproval.status !== "PASS") continue;
    creators[result.creatorId] = toHostCreatorEligibility(result);
  }
  return {
    campaignId: campaign.campaignId,
    supported: true,
    configured: HOST_KEYS.filter((k) => configured.has(k)).map(
      (k) => HOST_REQUIREMENT_LABELS[k],
    ),
    creators,
  };
}
