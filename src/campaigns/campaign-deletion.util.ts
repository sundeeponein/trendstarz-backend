/**
 * When a host may delete a campaign (mirrors the frontend's
 * `canDeletePendingCampaign` in campaign-management.component.ts).
 *
 * Only before admin approval, and only while no creator has accepted. After
 * that the campaign holds collaboration history (submissions, reviews, slots)
 * and possibly money, so it is ended or cancelled instead — never deleted.
 */
export const DELETABLE_CAMPAIGN_STATUSES = [
  "draft",
  "needs_changes",
  "rejected",
  "pending",
  "pending_review",
];

/** Invites that carry no accepted work: deleting them loses nothing. */
export const DELETABLE_INVITE_STATUSES = ["pending", "invited", "declined", "withdrawn"];

export function campaignDeletionBlocker(input: {
  campaignStatus: unknown;
  inviteStatuses: unknown[];
  hasPaymentRows: boolean;
}): string | null {
  const status = String(input.campaignStatus || "").toLowerCase();
  if (!DELETABLE_CAMPAIGN_STATUSES.includes(status)) {
    return "Only draft, needs-changes, rejected, pending or in-review campaigns can be deleted. End or cancel it instead.";
  }
  const accepted = input.inviteStatuses.some(
    (s) => !DELETABLE_INVITE_STATUSES.includes(String(s || "").toLowerCase()),
  );
  if (accepted) {
    return "A creator has already accepted this campaign, so it can't be deleted. End or cancel it instead.";
  }
  if (input.hasPaymentRows) {
    return "This campaign has a payment started or made, so it can't be deleted. Contact TrendStarZ if it needs to be closed.";
  }
  return null;
}
