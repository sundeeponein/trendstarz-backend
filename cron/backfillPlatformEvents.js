// cron/backfillPlatformEvents.js
//
// One-shot, re-runnable backfill of the platform_events collection from
// historical campaign / invite / submission / transaction records.
//
// What gets derived (and what deliberately doesn't) is documented in
// cron/lib/platformEventBackfill.js. Every row is tagged
// metadata: { source: "backfill", confidence: "derived", derivedFrom: "<field>" }.
//
// Safety:
// - Dry-run by default (prints what it would insert). Writes only with --apply.
// - Insert-only: upserts with $setOnInsert keyed on dedupeKey — never updates or
//   deletes anything, in platform_events or in the source collections.
// - Idempotent: uses the same dedupeKeys as the live recording code, so running
//   it twice, or after live events already exist, inserts nothing new.
//
// Usage:
//   MONGODB_URI=mongodb://... node cron/backfillPlatformEvents.js
//   MONGODB_URI=mongodb://... node cron/backfillPlatformEvents.js --apply

const mongoose = require('mongoose');
const { deriveEvents, toUpsertOps } = require('./lib/platformEventBackfill');

const MONGODB_URI = process.env.MONGODB_URI;
const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 500;
const TAG = '[backfill-platform-events]';

function isValidMongoUri(uri) {
  return typeof uri === 'string' && (uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://'));
}

async function run() {
  if (!isValidMongoUri(MONGODB_URI)) {
    console.error('MONGODB_URI is missing/invalid. It must start with mongodb:// or mongodb+srv://');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(TAG, 'connected', APPLY ? '(APPLY)' : '(DRY RUN)');
  const db = mongoose.connection;

  const [campaigns, invites, submissions, transactions] = await Promise.all([
    db.collection('campaigns').find({}, {
      projection: { brandId: 1, ownerType: 1, createdByRole: 1, campaignType: 1, campaignMode: 1, status: 1, createdAt: 1, completedAt: 1, completedBy: 1 },
    }).toArray(),
    db.collection('campaigninvites').find({}, {
      projection: { campaignId: 1, brandId: 1, influencerId: 1, recipientRole: 1, status: 1, selectedPlatform: 1, agreedAmount: 1, createdAt: 1, acceptedAt: 1, withdrawnAt: 1, withdrawnReason: 1 },
    }).toArray(),
    db.collection('campaignsubmissions').find({}, {
      projection: { campaignId: 1, influencerId: 1, inviteId: 1, status: 1, postPlatform: 1, postType: 1, isLate: 1, resubmissionCount: 1, submittedAt: 1, reviewedAt: 1, autoCompletedAt: 1 },
    }).toArray(),
    db.collection('campaigntransactions').find({}, {
      projection: { campaignId: 1, inviteId: 1, payerId: 1, payerRole: 1, transactionType: 1, direction: 1, gateway: 1, payoutGatewayProvider: 1, collectionStatus: 1, collectedAt: 1, payoutStatus: 1, paidOutAt: 1, agreedAmount: 1, payerTotal: 1, recipientPayout: 1 },
    }).toArray(),
  ]);
  console.log(TAG, 'source rows', {
    campaigns: campaigns.length,
    invites: invites.length,
    submissions: submissions.length,
    transactions: transactions.length,
  });

  const { events, skipped } = deriveEvents(
    { campaigns, invites, submissions, transactions },
    (hex) => new mongoose.Types.ObjectId(hex),
  );

  const byType = {};
  for (const e of events) byType[e.eventType] = (byType[e.eventType] || 0) + 1;
  const withLegacyIds = events.filter((e) => e.metadata.legacyIds).length;
  console.log(TAG, 'derivable events by type', byType);
  console.log(TAG, 'events carrying non-ObjectId legacy refs (kept in metadata.legacyIds)', withLegacyIds);
  console.log(TAG, 'not derived (no reliable source data)', skipped);

  const events$ = db.collection('platform_events');
  const existing = await events$.countDocuments({ dedupeKey: { $in: events.map((e) => e.dedupeKey) } });
  console.log(TAG, `already recorded: ${existing}, new: ${events.length - existing}`);

  if (!APPLY) {
    console.log(TAG, 'dry run — nothing written. Re-run with --apply to insert.');
    await mongoose.disconnect();
    return;
  }

  // Same unique index the PlatformEvent schema declares; a no-op if the app already built it.
  await events$.createIndex(
    { dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
  );

  const now = new Date();
  let inserted = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const ops = toUpsertOps(events.slice(i, i + BATCH_SIZE), now);
    try {
      const res = await events$.bulkWrite(ops, { ordered: false });
      inserted += res.upsertedCount || 0;
    } catch (err) {
      // A live event landing between our read and write races on the unique key — expected, skip it.
      const writeErrors = (err && err.writeErrors) || [];
      if (!writeErrors.length || writeErrors.some((w) => w.code !== 11000)) throw err;
      inserted += (err.result && err.result.upsertedCount) || 0;
    }
  }
  console.log(TAG, `inserted ${inserted} event(s)`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(TAG, 'failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
