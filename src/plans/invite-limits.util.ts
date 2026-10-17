/**
 * Plan limits for invites.
 *
 *   maxInvitesPerCampaign       how many invites a HOST may send per campaign
 *   maxInvitesReceivedPerMonth  how many invites a CREATOR may receive per plan month
 *
 * Before maxInvitesReceivedPerMonth existed, maxInvitesPerCampaign was reused
 * for both, so a plan without the new key keeps that behaviour (fallback).
 * -1 = unlimited.
 */
export const INVITES_PER_CAMPAIGN_KEY = "maxInvitesPerCampaign";
export const INVITES_RECEIVED_PER_MONTH_KEY = "maxInvitesReceivedPerMonth";

const valueOf = (limits: unknown, key: string): number | null => {
  const row = (Array.isArray(limits) ? limits : []).find(
    (l: any) => l?.key === key,
  );
  const v = Number(row?.value);
  return row && Number.isFinite(v) ? v : null;
};

/** Monthly receive cap from a plan's limits; null when the plan sets neither key. */
export function receivedInvitesPerMonthFrom(limits: unknown): number | null {
  return (
    valueOf(limits, INVITES_RECEIVED_PER_MONTH_KEY) ??
    valueOf(limits, INVITES_PER_CAMPAIGN_KEY)
  );
}
