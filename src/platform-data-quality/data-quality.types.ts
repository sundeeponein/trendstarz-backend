import { WindowKey } from "./kolkata-windows";

/**
 * Compact, grouped query results the service collects (read-only). Every list is
 * already grouped in MongoDB — one row per event type / campaign / recipient /
 * invite — so no raw event documents are loaded.
 */
export interface CollectedData {
  now: Date;
  /** $group by eventType + metadata.source. */
  typeSource: Array<{
    eventType: string;
    source: string | null;
    count: number;
    first: Date | null;
    last: Date | null;
  }>;
  /** $group by eventType: null-reference and actor-vs-subject counts. */
  perType: Array<{
    eventType: string;
    total: number;
    missingCampaignId: number;
    missingBrandId: number;
    missingInfluencerId: number;
    missingInviteId: number;
    missingRecipientRole: number;
    missingUserId: number;
    actorDiffersFromSubject: number;
  }>;
  /** $group by campaignId + brandId + eventType + event-carried ownerType/campaignMode. */
  byCampaign: Array<{
    campaignId: string | null;
    brandId: string | null;
    eventType: string;
    metaOwnerType: string | null;
    metaCampaignMode: string | null;
    count: number;
  }>;
  /** $group by influencerId + recipientRole (invite-scoped events). */
  recipients: Array<{
    influencerId: string | null;
    recipientRole: string | null;
    count: number;
  }>;
  /** One row per invite that has any event: first time of each step. */
  perInvite: InviteTimeline[];
  /** Events carrying metadata.legacyIds, grouped by field + value. */
  legacy: Array<{
    eventType: string;
    field: string;
    value: string;
    campaignId: string | null;
    count: number;
  }>;
  duplicateDedupeKeys: number;
  windowCounts: Array<{ eventType: string; counts: Record<WindowKey, number> }>;
  paymentStages: Array<{ stage: string | null; count: number }>;
  sampleSize: {
    creators: Array<{
      recipientRole: string | null;
      total: number;
      withMinSample: number;
    }>;
    owners: { total: number; withMinSample: number };
  };
  /** Current operational state, looked up by the ids the events reference. */
  campaigns: Map<
    string,
    {
      brandId: string | null;
      ownerType: string | null;
      campaignMode: string | null;
    }
  >;
  existing: {
    invites: Set<string>;
    influencers: Set<string>;
    photographers: Set<string>;
    brandOwners: Set<string>;
    photographerOwners: Set<string>;
  };
  /** Legacy username values that match a current brand/photographer username. */
  resolvableLegacyOwners: Set<string>;
  operational: {
    campaignsTotal: number;
    campaignsWithEvents: number;
    invitesTotal: number;
    invitesWithEvents: number;
    /** Invites on currently-open campaigns created before the Stage 1 boundary. */
    openCampaignInvitesBeforeStage1: number;
  };
  transactions: Array<{
    transactionType: string | null;
    collectionStatus: string | null;
    payoutStatus: string | null;
    resolveOutcome: string | null;
    agreedAmount: number | null;
    payerTotal: number | null;
    platformFee: number | null;
    recipientPayout: number | null;
    inviteId: string | null;
  }>;
  /** invite _id → agreedAmountPaise, for the transaction money-unit check. */
  invitePaise: Map<string, number | null>;
  platformPayments: Array<{
    purpose: string | null;
    gateway: string | null;
    count: number;
  }>;
}

export interface InviteTimeline {
  inviteId: string;
  campaignId: string | null;
  recipientRole: string | null;
  invitedAt: Date | null;
  invitedSource: string | null;
  appliedAt: Date | null;
  viewedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  counterSentAt: Date | null;
  workStartedAt: Date | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  lastDisputedAt: Date | null;
  withdrawnAt: Date | null;
  withdrawnReasonNull: boolean;
  withdrawnSource: string | null;
}
