import { PlatformEventType } from "./platform-event-types";

/**
 * When each tracking capability started recording in PRODUCTION.
 *
 * These are reviewed code, not runtime config: moving a boundary changes which
 * invites every cohort-limited metric counts, i.e. it changes historical metric
 * definitions.
 *
 * Boundaries are the confirmed production go-live times (the app-start log line
 * of the Railway deployment that shipped each stage). observedFirstEventAt is kept
 * as a cross-check: it must never be earlier than deployedAt. If a boundary ever
 * cannot be confirmed, set deployedAt: null and confidence "observed_first_event".
 */
export type CohortConfidence =
  | "confirmed_deployment"
  | "observed_first_event"
  // Shipped in code but not yet confirmed live: set deployedAt from the Railway
  // deployment log after release (until then nothing counts from this cohort).
  | "not_yet_deployed";

export interface TrackingCohort {
  /** Set only from confirmed deployment history. */
  deployedAt: Date | null;
  /** null only while confidence is "not_yet_deployed". */
  observedFirstEventAt: Date | null;
  confidence: CohortConfidence;
  evidence: string;
}

export const PLATFORM_EVENT_COHORTS: Record<
  "stage1" | "stage15" | "stage3d1c",
  TrackingCohort
> = {
  stage1: {
    deployedAt: new Date("2026-09-29T16:51:36.101Z"),
    observedFirstEventAt: new Date("2026-09-29T16:58:00.000Z"),
    confidence: "confirmed_deployment",
    evidence:
      "Railway deployment 232e1ec5 (commit 9a44ea9, created 2026-09-29T16:22:13Z): 'Nest application successfully started' logged at 2026-09-29T16:51:36Z. First production event 16:58:26Z.",
  },
  stage15: {
    deployedAt: new Date("2026-09-30T03:52:04.413Z"),
    observedFirstEventAt: new Date("2026-09-30T04:11:00.000Z"),
    confidence: "confirmed_deployment",
    evidence:
      "Railway deployment a5e9818b (commit 1cb95ae, created 2026-09-30T03:50:01Z): 'Nest application successfully started' logged at 2026-09-30T03:52:04Z. First production Stage 1.5 event 04:11:28Z.",
  },
  // Stage 3D-1c: counter_offer_declined.
  stage3d1c: {
    deployedAt: new Date("2026-10-08T14:35:38.000Z"),
    // No counter-offer has been declined in production yet (checked 2026-10-10).
    observedFirstEventAt: null,
    confidence: "confirmed_deployment",
    evidence:
      "Railway deployment 23aba8be (commit 6299780, created 2026-10-08T14:32:32Z): 'Nest application successfully started' logged at 2026-10-08T14:35:38Z. No counter_offer_declined event observed yet.",
  },
};

/** The boundary a cohort-limited metric must use; null while not yet deployed. */
export function cohortStartOrNull(cohort: TrackingCohort): Date | null {
  return cohort.deployedAt ?? cohort.observedFirstEventAt;
}

/** The boundary of a live cohort (stage1, stage15) — throws for one not yet deployed. */
export function cohortStart(cohort: TrackingCohort): Date {
  const start = cohortStartOrNull(cohort);
  if (!start) throw new Error("Cohort has no live boundary yet");
  return start;
}

export interface EventCoverage {
  /** Tracking capability that records it live (null = no source exists). */
  liveCohort: "stage1" | "stage15" | "stage3d1c" | null;
  backfillable: "yes" | "partial" | "no";
  backfillSource: string | null;
  historicalLimitation: string;
}

/**
 * What history exists for each event type — verified against the live hooks and
 * cron/lib/platformEventBackfill.js, not inferred from operational state.
 * Typed as a full Record so a new event type cannot be added without an entry.
 */
export const PLATFORM_EVENT_COVERAGE: Record<PlatformEventType, EventCoverage> =
  {
    campaign_created: {
      liveCohort: "stage1",
      backfillable: "yes",
      backfillSource: "campaign.createdAt",
      historicalLimitation: "Hard-deleted campaigns cannot be reconstructed.",
    },
    creator_invited: {
      liveCohort: "stage1",
      backfillable: "partial",
      backfillSource: "invite.createdAt (invite-only campaigns only)",
      historicalLimitation:
        "On open campaigns an invite row is either an owner invite or a creator application; the two are indistinguishable before Stage 1, so they are not backfilled. Invites whose campaign no longer exists are skipped.",
    },
    creator_applied: {
      liveCohort: "stage1",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "Pre-Stage-1 applications cannot be told apart from owner invites.",
    },
    invite_viewed: {
      liveCohort: "stage1",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "No view data was ever stored. Counts only the creator invite-feed request, once per invite.",
    },
    invite_accepted: {
      liveCohort: "stage1",
      backfillable: "yes",
      backfillSource:
        "invite.acceptedAt when no counter-offer; invite.counterOffer.resolvedAt when a counter ended in acceptance",
      historicalLimitation:
        "acceptedAt is also stamped at counter-send time, so invites with an open/declined counter are skipped. Backfilled rows have no actor (creator vs owner unknown).",
    },
    invite_declined: {
      liveCohort: "stage1",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation: "Declines were stored without a timestamp.",
    },
    invite_withdrawn: {
      liveCohort: "stage15",
      backfillable: "partial",
      backfillSource:
        "invite.withdrawnAt (reason only for exact system-written withdrawnReason text)",
      historicalLimitation:
        "Admin cancel-participation never set withdrawnAt, so those are missing; owner withdrawals and dispute refunds backfill with reason: null; previousStatus is always null when backfilled.",
    },
    counter_offer_sent: {
      liveCohort: "stage15",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "Only the latest counter's sentAt survives (an owner revision overwrites the creator's).",
    },
    counter_offer_declined: {
      liveCohort: "stage3d1c",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "Not backfilled: counterOffer.resolvedAt survives only for the latest counter (a later counter overwrites a declined one), and older declines have no actor.",
    },
    work_started: {
      liveCohort: "stage15",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation: "The move to 'working' was never timestamped.",
    },
    content_submitted: {
      liveCohort: "stage1",
      backfillable: "partial",
      backfillSource: "submission.submittedAt",
      historicalLimitation:
        "A resubmission overwrites submittedAt, so only the latest attempt is reconstructable.",
    },
    content_approved: {
      liveCohort: "stage1",
      backfillable: "yes",
      backfillSource:
        "submission.reviewedAt / autoCompletedAt (status approved)",
      historicalLimitation:
        "Final state only; backfilled rows have no actor except auto-complete.",
    },
    content_rejected: {
      liveCohort: "stage1",
      backfillable: "yes",
      backfillSource: "submission.reviewedAt (status rejected)",
      historicalLimitation:
        "Only produced by an admin dispute outcome in the owner's favour; the payments-side dispute resolver emits no content event.",
    },
    content_disputed: {
      liveCohort: "stage15",
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "A resubmission clears the dispute's reviewedAt, so dispute times do not survive.",
    },
    campaign_completed: {
      liveCohort: "stage1",
      backfillable: "partial",
      backfillSource: "campaign.completedAt",
      historicalLimitation:
        "Campaigns completed without completedAt cannot be reconstructed. Campaign-level only.",
    },
    payment_completed: {
      liveCohort: "stage1",
      backfillable: "yes",
      backfillSource:
        "transaction.collectedAt (stage collection) / transaction.paidOutAt (stage payout)",
      historicalLimitation:
        "Payment-side disputes (raiseDispute/resolveDispute) are not events.",
    },
    creator_selected: {
      liveCohort: null,
      backfillable: "no",
      backfillSource: null,
      historicalLimitation:
        "No business action exists: creators accept their own open-campaign applications and invite-only selection is the invite itself. Never recorded.",
    },
  };
