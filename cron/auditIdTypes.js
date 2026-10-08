// cron/auditIdTypes.js
//
// READ-ONLY. Reports how brand/campaign/creator/invite references are actually
// stored, as input to the ID-consistency migration. Writes nothing.
//
// Several of these fields are Schema.Types.Mixed, and the code writes them as
// whatever the request carried (usually a string). For each field it counts:
//   objectId     — stored as a real ObjectId (the target)
//   hexString    — a 24-hex string (convertible to ObjectId)
//   otherString  — a non-id string, e.g. a brand/photographer username (NOT convertible as-is)
//   missing      — null / absent
//   other        — any other BSON type
//
// Why the data can't just be converted yet: much of the code queries these
// fields with a plain string (e.g. countDocuments({ campaignId })) against a
// Mixed schema type, which does no casting — converting stored values to
// ObjectId first would silently make those queries match nothing. See the
// Stage 1 report for the phased plan.
//
// Usage:
//   MONGODB_URI=mongodb://... node cron/auditIdTypes.js

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const TAG = '[audit-id-types]';

const FIELDS = {
  campaigns: ['brandId'],
  campaigninvites: ['campaignId', 'brandId', 'influencerId'],
  campaignsubmissions: ['campaignId', 'influencerId', 'inviteId'],
  campaigntransactions: ['campaignId', 'inviteId', 'payerId', 'recipientId'],
  trackinglinks: ['campaignId', 'inviteId', 'recipientId'],
};

async function auditField(collection, field) {
  const [row] = await collection
    .aggregate([
      {
        $project: {
          kind: {
            $switch: {
              branches: [
                { case: { $eq: [{ $type: `$${field}` }, 'objectId'] }, then: 'objectId' },
                { case: { $in: [{ $type: `$${field}` }, ['missing', 'null']] }, then: 'missing' },
                {
                  case: {
                    $and: [
                      { $eq: [{ $type: `$${field}` }, 'string'] },
                      { $regexMatch: { input: `$${field}`, regex: /^[a-fA-F0-9]{24}$/ } },
                    ],
                  },
                  then: 'hexString',
                },
                { case: { $eq: [{ $type: `$${field}` }, 'string'] }, then: 'otherString' },
              ],
              default: 'other',
            },
          },
        },
      },
      { $group: { _id: '$kind', n: { $sum: 1 } } },
      { $group: { _id: null, counts: { $push: { k: '$_id', v: '$n' } } } },
      { $project: { _id: 0, counts: { $arrayToObject: '$counts' } } },
    ])
    .toArray();
  return (row && row.counts) || {};
}

async function run() {
  if (!MONGODB_URI || !/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) {
    console.error('MONGODB_URI is missing/invalid. It must start with mongodb:// or mongodb+srv://');
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  console.log(TAG, 'connected (read-only)');
  const db = mongoose.connection;

  for (const [name, fields] of Object.entries(FIELDS)) {
    const collection = db.collection(name);
    const total = await collection.estimatedDocumentCount();
    console.log(`\n${name} (${total} docs)`);
    for (const field of fields) {
      console.log(`  ${field.padEnd(14)}`, await auditField(collection, field));
    }
  }

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
