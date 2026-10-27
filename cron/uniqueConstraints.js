// cron/uniqueConstraints.js
//
// Audits, then (with --apply) builds, the database-level uniqueness rules the
// app already applies in code:
//
//   uniq_active_invite_per_recipient  campaigninvites  one ACTIVE invite per
//       campaign + recipient (declined/withdrawn rows are left out, so a
//       withdrawn creator can still be re-invited — see
//       src/campaigns/reinvite-rule.util.ts). Partial index; needs MongoDB 6.0+.
//   uniq_review_per_invite_side       reviews          one review per invite
//       per reviewer side (the guard in reviews.service.ts).
//   uniq_submission_per_invite        campaignsubmissions  one submitted post per
//       invite (submitPost and the late-post path find-or-create it; a double
//       click could otherwise create two and the app reads only one).
//   uniq_photographer_username        photographers    one photographer per
//   uniq_brand_username               brands           profile link name.
//
// Safety:
// - Dry-run by default: reads only, reports duplicates.
// - --apply builds an index ONLY when its audit found zero duplicates. It never
//   deletes or edits rows; duplicates must be resolved by hand first.
// - Re-running is safe (an existing index with the same name is skipped).
//
// campaigninvites.campaignId is a String in the schema (locked 2026-10-17; prod
// held only hex strings), so new rows can't sneak past the index as an ObjectId.
// The audit still groups by string form in case raw writes bypass the schema.
//
// Usage:
//   MONGODB_URI=mongodb://... node cron/uniqueConstraints.js
//   MONGODB_URI=mongodb://... node cron/uniqueConstraints.js --apply

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const APPLY = process.argv.includes('--apply');
const TAG = '[unique-constraints]';

// Keep in sync with ACTIVE_INVITE_STATUSES in src/campaigns/reinvite-rule.util.ts.
const ACTIVE_INVITE_STATUSES = [
  'pending',
  'invited',
  'counter_sent',
  'accepted',
  'payment_confirmed',
  'working',
  'submitted',
  'completed',
  'approved',
  'disputed',
];

const CONSTRAINTS = [
  {
    name: 'uniq_active_invite_per_recipient',
    collection: 'campaigninvites',
    keys: { campaignId: 1, influencerId: 1 },
    match: { status: { $in: ACTIVE_INVITE_STATUSES } },
    group: {
      campaignId: { $toString: '$campaignId' },
      influencerId: { $toString: '$influencerId' },
    },
    options: { partialFilterExpression: { status: { $in: ACTIVE_INVITE_STATUSES } } },
    minMongoMajor: 6,
  },
  {
    name: 'uniq_review_per_invite_side',
    collection: 'reviews',
    keys: { inviteId: 1, reviewerType: 1 },
    match: {},
    group: { inviteId: { $toString: '$inviteId' }, reviewerType: '$reviewerType' },
    options: {},
    minMongoMajor: 0,
  },
  {
    name: 'uniq_submission_per_invite',
    collection: 'campaignsubmissions',
    keys: { inviteId: 1 },
    match: {},
    group: { inviteId: { $toString: '$inviteId' } },
    options: {},
    minMongoMajor: 0,
  },
  // Profile links: /photographer/<username> and /brand/<brandUsername> must name
  // one account (influencer usernames already have a unique index). Deleted
  // photographers get an empty username, so only non-empty names count.
  {
    name: 'uniq_photographer_username',
    collection: 'photographers',
    keys: { username: 1 },
    match: { username: { $type: 'string', $gt: '' } },
    group: { username: '$username' },
    options: { partialFilterExpression: { username: { $type: 'string', $gt: '' } } },
    minMongoMajor: 0,
  },
  {
    name: 'uniq_brand_username',
    collection: 'brands',
    keys: { brandUsername: 1 },
    match: { brandUsername: { $type: 'string', $gt: '' } },
    group: { brandUsername: '$brandUsername' },
    options: { partialFilterExpression: { brandUsername: { $type: 'string', $gt: '' } } },
    minMongoMajor: 0,
  },
];

async function findDuplicates(db, c) {
  return db
    .collection(c.collection)
    .aggregate([
      { $match: c.match },
      {
        $group: {
          _id: c.group,
          count: { $sum: 1 },
          ids: { $push: '$_id' },
          statuses: { $push: '$status' },
          // >1 distinct BSON types means the index alone would not catch it.
          types: { $addToSet: { $type: `$${Object.keys(c.keys)[0]}` } },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
}

async function run() {
  if (!MONGODB_URI || !/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) {
    throw new Error('MONGODB_URI is missing or invalid');
  }
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const { version } = await db.admin().serverInfo();
  const major = Number(String(version).split('.')[0]);
  console.log(`${TAG} mode=${APPLY ? 'APPLY' : 'DRY RUN'} mongo=${version}`);

  let blocked = 0;
  for (const c of CONSTRAINTS) {
    const existing = await db.collection(c.collection).indexes();
    if (existing.some((i) => i.name === c.name)) {
      console.log(`${TAG} ${c.name}: already built — skip`);
      continue;
    }
    const dups = await findDuplicates(db, c);
    console.log(`${TAG} ${c.name}: ${dups.length} duplicate group(s)`);
    for (const d of dups.slice(0, 20)) {
      console.log(
        `${TAG}   ${JSON.stringify(d._id)} x${d.count} ids=${d.ids.join(',')} statuses=${d.statuses.join(',')} idTypes=${d.types.join('/')}`,
      );
    }
    if (dups.length) {
      blocked++;
      continue;
    }
    if (major < c.minMongoMajor) {
      console.log(`${TAG} ${c.name}: needs MongoDB ${c.minMongoMajor}+ — skip`);
      blocked++;
      continue;
    }
    if (!APPLY) {
      console.log(`${TAG} ${c.name}: clean — would build with --apply`);
      continue;
    }
    await db
      .collection(c.collection)
      .createIndex(c.keys, { ...c.options, name: c.name, unique: true });
    console.log(`${TAG} ${c.name}: built`);
  }

  await mongoose.disconnect();
  if (blocked) {
    console.log(`${TAG} ${blocked} constraint(s) not built — resolve the rows above first`);
  }
}

run().catch(async (err) => {
  console.error(`${TAG} error:`, err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
