/**
 * One-time backfill: assign sequential, role-prefixed publicId values
 * (e.g. "INF100057", "BRD100022", "PHO100011") to all influencers, brands,
 * and photographers that don't already have one, oldest-first.
 *
 * Usage:
 *   node scripts/backfill-public-ids.js
 *
 * Safe to re-run — skips docs that already have a publicId and only raises
 * (never lowers) each role's counter, so the live generator in
 * auth.service.ts (nextPublicId) never collides with backfilled IDs.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/trendstarz';
const ID_OFFSET = 100000;

const ROLES = [
  { collection: 'influencers', prefix: 'INF', counterKey: 'influencer_public_id' },
  { collection: 'brands', prefix: 'BRD', counterKey: 'brand_public_id' },
  { collection: 'photographers', prefix: 'PHO', counterKey: 'photographer_public_id' },
];

async function backfillRole({ collection, prefix, counterKey }, Counter) {
  const Model = mongoose.connection.collection(collection);

  const docs = await Model
    .find({ publicId: { $exists: false } })
    .sort({ firstRegisteredAt: 1, createdAt: 1 })
    .project({ _id: 1 })
    .toArray();

  console.log(`[${collection}] Found ${docs.length} doc(s) needing a publicId.`);

  // Starting point: the higher of (max seq already used in existing
  // publicId values) and (the counter doc's current seq, in case a live
  // registration already incremented it) — never restart below either.
  const maxDoc = await Model
    .find({ publicId: { $exists: true } })
    .sort({ publicId: -1 })
    .limit(1)
    .project({ publicId: 1 })
    .next();
  const maxSeqFromDocs = maxDoc
    ? parseInt(String(maxDoc.publicId).slice(prefix.length), 10) - ID_OFFSET
    : 0;
  const counterDoc = await Counter.findOne({ _id: counterKey });
  let seq = Math.max(maxSeqFromDocs || 0, counterDoc?.seq ?? 0, 0);

  if (docs.length) {
    const ops = docs.map((doc) => {
      seq++;
      return {
        updateOne: {
          filter: { _id: doc._id, publicId: { $exists: false } },
          update: { $set: { publicId: `${prefix}${ID_OFFSET + seq}` } },
        },
      };
    });
    const result = await Model.bulkWrite(ops, { ordered: false });
    console.log(`[${collection}] Backfilled ${result.modifiedCount} doc(s). Last seq: ${seq}`);
  } else {
    console.log(`[${collection}] Nothing to backfill.`);
  }

  await Counter.updateOne(
    { _id: counterKey },
    { $max: { seq } },
    { upsert: true },
  );
  console.log(`[${collection}] Counter "${counterKey}" set to seq = ${seq}`);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI.replace(/:\/\/.*@/, '://***@'));

  const Counter = mongoose.connection.collection('counters');

  for (const role of ROLES) {
    await backfillRole(role, Counter);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
