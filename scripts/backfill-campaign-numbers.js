/**
 * One-time backfill: assign sequential campaignNumber values to all campaigns
 * that don't already have one, starting from 1001.
 *
 * Usage:
 *   node scripts/backfill-campaign-numbers.js
 *
 * Safe to re-run — it skips campaigns that already have a campaignNumber and
 * only initialises the counter document if it doesn't exist yet.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/trendstarz';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI.replace(/:\/\/.*@/, '://***@'));

  const Campaign = mongoose.connection.collection('campaigns');
  const Counter  = mongoose.connection.collection('counters');

  // Fetch all campaigns without a campaignNumber, sorted oldest-first
  const campaigns = await Campaign
    .find({ campaignNumber: { $exists: false } })
    .sort({ createdAt: 1 })
    .project({ _id: 1, title: 1 })
    .toArray();

  console.log(`Found ${campaigns.length} campaign(s) needing a campaignNumber.`);
  if (campaigns.length === 0) {
    console.log('Nothing to do. Exiting.');
    await mongoose.disconnect();
    return;
  }

  // Find starting point: max of existing campaignNumbers or 1000
  const maxDoc = await Campaign
    .find({ campaignNumber: { $exists: true } })
    .sort({ campaignNumber: -1 })
    .limit(1)
    .project({ campaignNumber: 1 })
    .next();

  let seq = Math.max(maxDoc?.campaignNumber ?? 1000, 1000);

  const ops = campaigns.map(c => {
    seq++;
    return {
      updateOne: {
        filter: { _id: c._id, campaignNumber: { $exists: false } },
        update: { $set: { campaignNumber: seq } },
      },
    };
  });

  const result = await Campaign.bulkWrite(ops, { ordered: false });
  console.log(`Backfilled ${result.modifiedCount} campaign(s). Last number assigned: ${seq}`);

  // Upsert counter so future inserts continue from here
  await Counter.updateOne(
    { _id: 'campaign' },
    { $max: { seq } },          // only raise seq, never lower it
    { upsert: true },
  );
  console.log(`Counter "campaign" set to seq = ${seq}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
