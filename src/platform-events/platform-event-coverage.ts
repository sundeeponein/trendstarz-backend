import { PlatformEventType } from "./platform-event-types";

/**
 * When each tracking capability started recording in PRODUCTION.
 *
 * These are reviewed code, not runtime config: moving a boundary changes which
 * invites every cohort-limited metric counts, i.e. it changes historical metric
 * definitions.
 *
 * Neither deployment time could be established from hosting history (the repo
 * has no deploy config, and a local backend has also written to the production
 * database), so both are provisional LOWER BOUNDS — the first event of that
 * capability observed in production, truncated to the minute. They are labelled
 * observedFirstEventAt, never deployedAt. When hosting history confirms the real
 * deploy times, set `deployedAt`, switch `confidence` to "confirmed_deployment"
 * and record the source in `evidence`.
 */
export type CohortConfidence = "confirmed_deployment" | "observed_first_event";

export interface TrackingCohort {
  /** Set only from confirmed deployment history. */
  deployedAt: Date | null;
  observedFirstEventAt: Date;
  confidence: CohortConfidence;
  evidence: string;
}

export const PLATFORM_EVENT_COHORTS: Record<
  "stage1" | "stage15",
  TrackingCohort
> = {
  stage1: {
    deployedAt: null,
    observedFirstEventAt: new Date("2026-09-29T16:58:00.000Z"),
    confidence: "observed_first_event",
    evidence:
      "First production platform_event (campaign_completed, 2026-09-29T16:58:26Z). Commit 9a44ea9 at 2026-09-29T16:22:06Z; deploy time not confirmed.",
  },
  stage15: {
    deployedAt: null,
    observedFirstEventAt: new Date("2026-09-30T04:11:00.000Z"),
    confidence: "observed_first_event",
    evidence:
      "First production Stage 1.5 event (counter_offer_sent, 2026-09-30T04:11:28Z). Commit 1cb95ae at 2026-09-30T03:49:55Z; deploy time not confirmed, and a local backend was writing to production at the time.",
  },
};

/** The boundary a cohort-limited metric must use. */
export function cohortStart(cohort: TrackingCohort): Date {
  return cohort.deployedAt ?? cohort.observedFirstEventAt;
}

export interface EventCoverage {
  /** Tracking capability that records it live (null = no source exists). */
  liveCohort: "stage1" | "stage15" | null;
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
