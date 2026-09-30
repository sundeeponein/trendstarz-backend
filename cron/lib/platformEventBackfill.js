// cron/lib/platformEventBackfill.js
//
// Pure derivation logic for cron/backfillPlatformEvents.js — kept free of DB
// access so it can be unit-tested (src/platform-events/platform-event-backfill.spec.ts).
//
// Rules: only emit an event when the stored record reliably says it happened,
// and when. Nothing is invented:
//   - invite_viewed        never (no historical view data exists)
//   - creator_selected     never (no such action exists)
//   - invite_declined      never (declines have no timestamp — only status)
//   - creator_invited /
//     creator_applied      only for invite-only campaigns (every invite there was
//                          sent by the owner); open campaigns mix owner invites and
//                          creator applications with no stored way to tell them apart
//   - content_submitted    only the latest attempt (a resubmission overwrites submittedAt)
//   - invite_withdrawn     only when withdrawnAt is stored (the admin cancel-participation
//                          override never set it); metadata.reason only when withdrawnReason
//                          is one of the exact strings the system itself writes — owner-typed
//                          reasons, dispute refunds, etc. stay reason: null
//   - work_started,
//     content_disputed,
//     counter_offer_sent   never (no reliable timestamp: work start isn't stored, a resubmission
//                          clears the dispute's reviewedAt, and only the latest counter's
//                          sentAt survives)
//
// Every derived event uses the SAME dedupeKey the live code uses, so re-running
// the backfill — or running it after live events already exist — never duplicates.

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

// Must stay a subset of src/platform-events/platform-event-types.ts (checked by the spec).
const BACKFILLABLE_EVENT_TYPES = [
  'campaign_created',
  'creator_invited',
  'invite_accepted',
  'content_submitted',
  'content_approved',
  'content_rejected',
  'campaign_completed',
  'payment_completed',
  'invite_withdrawn',
];

/** System-written withdrawnReason strings (campaign-invites.service.ts) → invite_withdrawn reason. */
function classifyWithdrawnReason(text) {
  const t = String(text || '').trim();
  if (/^Auto-closed after \d+ (influencer|photographer) acceptances?\.$/.test(t)) return 'auto_close';
  if (t === 'Campaign ended before this invite was accepted.') return 'expired_never_accepted';
  if (
    t === "Campaign's grace period ended with no submission." ||
    t === 'Campaign ended by host before submission.' ||
    t === 'Posting deadline and grace period expired with no submission.'
  ) {
    return 'expired_unsubmitted';
  }
  return null;
}

function idString(value) {
  if (value == null) return '';
  // Check ObjectId first: BSON ObjectIds expose `_id` as a getter returning themselves.
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (typeof value === 'object' && value._id != null && value._id !== value) return idString(value._id);
  return String(value).trim();
}

function validDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizePlatform(value) {
  const p = String(value == null ? '' : value).trim().toLowerCase();
  if (!p) return null;
  return p === 'x' ? 'twitter' : p;
}

function recipientRoleOf(invite) {
  return String((invite && invite.recipientRole) || '').trim().toLowerCase() === 'photographer'
    ? 'photographer'
    : 'influencer';
}

function ownerRoleOf(campaign) {
  return String((campaign && (campaign.ownerType || campaign.createdByRole)) || 'brand') === 'photographer'
    ? 'photographer'
    : 'brand';
}

/**
 * Builds one stored event. `toObjectId(hex)` is injected (mongoose.Types.ObjectId
 * in the script) so this file needs no DB driver.
 */
function buildEvent(toObjectId, input) {
  const legacyIds = {};
  const doc = {
    eventType: input.eventType,
    timestamp: input.timestamp,
    userRole: input.userRole || null,
    recipientRole: input.recipientRole || null,
    platform: normalizePlatform(input.platform),
    metadata: Object.assign(
      { source: 'backfill', confidence: 'derived', derivedFrom: input.derivedFrom },
      input.metadata || {},
    ),
    dedupeKey: input.dedupeKey,
  };
  for (const field of ['userId', 'brandId', 'campaignId', 'influencerId', 'inviteId']) {
    const raw = idString(input[field]);
    if (OBJECT_ID_HEX.test(raw)) {
      doc[field] = toObjectId(raw);
    } else {
      doc[field] = null;
      if (raw) legacyIds[field] = raw;
    }
  }
  if (Object.keys(legacyIds).length) doc.metadata.legacyIds = legacyIds;
  return doc;
}

/**
 * @param {{campaigns:any[], invites:any[], submissions:any[], transactions:any[]}} data
 * @param {(hex:string)=>any} toObjectId
 * @returns {{ events: any[], skipped: Record<string, number> }}
 */
function deriveEvents(data, toObjectId) {
  const events = [];
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const campaignsById = new Map((data.campaigns || []).map((c) => [idString(c._id), c]));
  const invitesById = new Map((data.invites || []).map((i) => [idString(i._id), i]));

  for (const campaign of data.campaigns || []) {
    const id = idString(campaign._id);
    const ownerRole = ownerRoleOf(campaign);
    const createdAt = validDate(campaign.createdAt);
    if (createdAt) {
      events.push(buildEvent(toObjectId, {
        eventType: 'campaign_created',
        derivedFrom: 'campaign.createdAt',
        timestamp: createdAt,
        userId: campaign.brandId,
        userRole: ownerRole,
        brandId: campaign.brandId,
        campaignId: id,
        metadata: {
          ownerType: ownerRole,
          campaignType: campaign.campaignType || null,
          campaignMode: campaign.campaignMode || null,
        },
        dedupeKey: `campaign_created:${id}`,
      }));
    } else {
      skip('campaign_created: no createdAt');
    }

    if (String(campaign.status || '') === 'completed') {
      const completedAt = validDate(campaign.completedAt);
      if (!completedAt) {
        skip('campaign_completed: completed campaign has no completedAt');
      } else {
        const completedBy = String(campaign.completedBy || '');
        events.push(buildEvent(toObjectId, {
          eventType: 'campaign_completed',
          derivedFrom: 'campaign.completedAt',
          timestamp: completedAt,
          userId: completedBy === 'host' ? campaign.brandId : null,
          userRole:
            completedBy === 'host' ? ownerRole : completedBy === 'admin' ? 'admin' : completedBy === 'auto' ? 'system' : null,
          brandId: campaign.brandId,
          campaignId: id,
          metadata: { ownerType: ownerRole, completedBy: completedBy || null },
          dedupeKey: `campaign_completed:${id}`,
        }));
      }
    }
  }

  for (const invite of data.invites || []) {
    const id = idString(invite._id);
    const campaign = campaignsById.get(idString(invite.campaignId));
    const refs = {
      brandId: invite.brandId,
      campaignId: invite.campaignId,
      influencerId: invite.influencerId,
      inviteId: id,
      recipientRole: recipientRoleOf(invite),
    };

    const createdAt = validDate(invite.createdAt);
    if (!campaign) {
      skip('creator_invited: campaign missing');
    } else if (String(campaign.campaignMode || 'invite_only') !== 'invite_only') {
      skip('creator_invited/creator_applied: open campaign (invite vs application not recorded)');
    } else if (!createdAt) {
      skip('creator_invited: no createdAt');
    } else {
      events.push(buildEvent(toObjectId, Object.assign({}, refs, {
        eventType: 'creator_invited',
        derivedFrom: 'invite.createdAt',
        timestamp: createdAt,
        userId: invite.brandId,
        userRole: ownerRoleOf(campaign),
        platform: invite.selectedPlatform,
        metadata: { campaignMode: 'invite_only' },
        dedupeKey: `creator_invited:${id}`,
      })));
    }

    // invite.acceptedAt is also stamped when the creator SENDS a counter-offer, so it is only
    // an acceptance time when no counter is involved. A counter that ended in acceptance
    // records the real moment in counterOffer.resolvedAt; an open/declined counter means
    // acceptedAt is just the counter-send time, not an acceptance at all.
    const counterStatus = String((invite.counterOffer && invite.counterOffer.status) || 'none');
    let acceptedAt = null;
    let acceptedFrom = null;
    if (counterStatus === 'accepted') {
      acceptedAt = validDate(invite.counterOffer.resolvedAt);
      acceptedFrom = 'invite.counterOffer.resolvedAt';
      if (!acceptedAt) skip('invite_accepted: counter accepted but no resolvedAt');
    } else if (counterStatus === 'none') {
      acceptedAt = validDate(invite.acceptedAt);
      acceptedFrom = 'invite.acceptedAt';
    } else if (validDate(invite.acceptedAt)) {
      skip('invite_accepted: acceptedAt is a counter-offer send time (counter ' + counterStatus + ')');
    }
    if (acceptedAt) {
      events.push(buildEvent(toObjectId, Object.assign({}, refs, {
        eventType: 'invite_accepted',
        derivedFrom: acceptedFrom,
        timestamp: acceptedAt,
        // Actor unknown: the creator accepts, but the owner can also accept the creator's counter.
        platform: invite.selectedPlatform,
        metadata: { agreedAmount: invite.agreedAmount == null ? null : invite.agreedAmount },
        dedupeKey: `invite_accepted:${id}`,
      })));
    }
    if (String(invite.status || '') === 'declined') skip('invite_declined: no decline timestamp stored');

    if (String(invite.status || '') === 'withdrawn') {
      const withdrawnAt = validDate(invite.withdrawnAt);
      if (!withdrawnAt) {
        skip('invite_withdrawn: withdrawn without withdrawnAt (e.g. admin cancel-participation)');
      } else {
        const reason = classifyWithdrawnReason(invite.withdrawnReason);
        if (!reason) skip('invite_withdrawn: reason not classifiable (recorded with reason: null)');
        events.push(buildEvent(toObjectId, Object.assign({}, refs, {
          eventType: 'invite_withdrawn',
          derivedFrom: 'invite.withdrawnAt',
          timestamp: withdrawnAt,
          userRole: reason ? 'system' : null,
          platform: invite.selectedPlatform,
          metadata: { reason, previousStatus: null },
          dedupeKey: `invite_withdrawn:${id}`,
        })));
      }
    }
  }

  for (const submission of data.submissions || []) {
    const inviteId = idString(submission.inviteId);
    const invite = invitesById.get(inviteId) || {};
    const refs = {
      brandId: invite.brandId,
      campaignId: submission.campaignId || invite.campaignId,
      influencerId: submission.influencerId || invite.influencerId,
      inviteId,
      recipientRole: recipientRoleOf(invite),
      platform: submission.postPlatform || invite.selectedPlatform,
    };
    const baseMeta = {
      submissionId: idString(submission._id),
      postType: submission.postType || null,
      resubmissionCount: Number(submission.resubmissionCount || 0),
    };

    const submittedAt = validDate(submission.submittedAt);
    if (submittedAt && String(submission.status || '') !== 'draft') {
      events.push(buildEvent(toObjectId, Object.assign({}, refs, {
        eventType: 'content_submitted',
        derivedFrom: 'submission.submittedAt',
        timestamp: submittedAt,
        userId: submission.influencerId || invite.influencerId,
        userRole: recipientRoleOf(invite),
        metadata: Object.assign({}, baseMeta, { isLate: !!submission.isLate }),
        dedupeKey: `content_submitted:${inviteId}:${baseMeta.resubmissionCount}`,
      })));
    }

    const status = String(submission.status || '');
    const reviewedAt = validDate(submission.reviewedAt) || validDate(submission.autoCompletedAt);
    if (status === 'approved' || status === 'rejected') {
      if (!reviewedAt) {
        skip(`content_${status}: no reviewedAt`);
        continue;
      }
      const autoCompleted = status === 'approved' && !!validDate(submission.autoCompletedAt);
      events.push(buildEvent(toObjectId, Object.assign({}, refs, {
        eventType: status === 'approved' ? 'content_approved' : 'content_rejected',
        derivedFrom: autoCompleted ? 'submission.autoCompletedAt' : 'submission.reviewedAt',
        timestamp: reviewedAt,
        userRole: autoCompleted ? 'system' : null,
        metadata: Object.assign({}, baseMeta, { via: autoCompleted ? 'auto_complete' : null }),
        dedupeKey: `${status === 'approved' ? 'content_approved' : 'content_rejected'}:${inviteId}`,
      })));
    }
  }

  for (const tx of data.transactions || []) {
    const txId = idString(tx._id);
    const invite = invitesById.get(idString(tx.inviteId)) || {};
    const refs = {
      brandId: invite.brandId,
      campaignId: tx.campaignId || invite.campaignId,
      influencerId: invite.influencerId,
      inviteId: tx.inviteId,
      recipientRole: invite.recipientRole ? recipientRoleOf(invite) : null,
      platform: invite.selectedPlatform,
    };
    const money = {
      transactionId: txId,
      transactionType: tx.transactionType || null,
      direction: tx.direction || null,
      agreedAmount: tx.agreedAmount == null ? null : tx.agreedAmount,
      payerTotal: tx.payerTotal == null ? null : tx.payerTotal,
      recipientPayout: tx.recipientPayout == null ? null : tx.recipientPayout,
    };

    const collectedAt = validDate(tx.collectedAt);
    if (String(tx.collectionStatus || '') === 'verified') {
      if (!collectedAt) {
        skip('payment_completed(collection): verified without collectedAt');
      } else {
        events.push(buildEvent(toObjectId, Object.assign({}, refs, {
          eventType: 'payment_completed',
          derivedFrom: 'transaction.collectedAt',
          timestamp: collectedAt,
          userId: tx.payerId,
          userRole: tx.payerRole || null,
          metadata: Object.assign({ stage: 'collection', gateway: tx.gateway || null }, money),
          dedupeKey: `payment_completed:collection:${txId}`,
        })));
      }
    }

    const paidOutAt = validDate(tx.paidOutAt);
    if (String(tx.payoutStatus || '') === 'paid') {
      if (!paidOutAt) {
        skip('payment_completed(payout): paid without paidOutAt');
      } else {
        const provider = String(tx.payoutGatewayProvider || 'manual_upi');
        events.push(buildEvent(toObjectId, Object.assign({}, refs, {
          eventType: 'payment_completed',
          derivedFrom: 'transaction.paidOutAt',
          timestamp: paidOutAt,
          userRole: provider === 'manual_upi' ? 'admin' : 'system',
          metadata: Object.assign({ stage: 'payout', gateway: provider }, money),
          dedupeKey: `payment_completed:payout:${txId}`,
        })));
      }
    }
  }

  return { events, skipped };
}

/** Insert-only upserts keyed on dedupeKey: existing rows (live or backfilled) are never modified. */
function toUpsertOps(events, now) {
  return events.map((doc) => ({
    updateOne: {
      filter: { dedupeKey: doc.dedupeKey },
      update: { $setOnInsert: Object.assign({}, doc, { createdAt: now }) },
      upsert: true,
    },
  }));
}

module.exports = {
  BACKFILLABLE_EVENT_TYPES,
  classifyWithdrawnReason,
  deriveEvents,
  toUpsertOps,
};
