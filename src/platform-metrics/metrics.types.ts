/** Where a step's timestamp came from (metadata.source). */
export type StepSource = "live" | "backfill" | null;

export interface Step {
  at: Date | null;
  source: StepSource;
}

/**
 * One invite's history, built by a single $group over platform_events (one row
 * per invite, not per event). Every Stage 2B creator / owner / campaign / funnel
 * metric is derived from these rows plus the per-campaign rows below.
 */
export interface InviteJourney {
  inviteId: string;
  campaignId: string | null;
  /** Campaign owner (brand or photographer). */
  ownerId: string | null;
  /** Invite recipient — an influencer or a photographer (see recipientRole). */
  creatorId: string | null;
  recipientRole: string | null;
  platform: string | null;
  /** campaignMode carried by creator_invited / creator_applied (historical). */
  eventCampaignMode: string | null;
  invited: Step;
  applied: Step;
  viewed: Step;
  counterSent: Step;
  accepted: Step;
  declined: Step;
  workStarted: Step;
  submitted: Step;
  approved: Step;
  rejected: Step;
  firstDisputed: Step;
  lastDisputed: Step;
  withdrawn: Step;
  withdrawnReason: string | null;
  collection: Step;
  payout: Step;
  collectionPaise: number | null;
  payoutPaise: number | null;
}

/** One row per campaign that has events, plus its current operational state. */
export interface CampaignRecord {
  campaignId: string;
  ownerId: string | null;
  created: Step;
  completed: Step;
  completedBy: string | null;
  /** Values carried by campaign_created (historical). */
  eventCampaignMode: string | null;
  eventCampaignType: string | null;
  eventOwnerType: string | null;
  /** Current state from the campaigns collection (null if the campaign is gone). */
  current: {
    campaignMode: string | null;
    campaignType: string | null;
    ownerType: string | null;
    status: string | null;
  } | null;
}

export interface JourneyData {
  now: Date;
  journeys: InviteJourney[];
  campaigns: Map<string, CampaignRecord>;
}

/** A rate that refuses to exist below the sample threshold. */
export interface Rate {
  numerator: number;
  denominator: number;
  sampleSize: number;
  rate: number | null;
  status: "ok" | "insufficient_data";
}

export interface DurationStats {
  sampleSize: number;
  medianHours: number | null;
  averageHours: number | null;
  /** Pairs using at least one backfilled (derived) timestamp. */
  derivedPairs: number;
  status: "ok" | "insufficient_data";
}
