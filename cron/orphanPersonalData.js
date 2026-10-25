// Removes personal records left behind by accounts that no longer exist (or
// were anonymized): moderation flags, notifications, social-account checks,
// profile statistics. Account deletion now removes these itself
// (UsersService.removePersonalTraces); this clears what older deletions left.
//
// Usage (from trendstarz-backend/):
//   node cron/orphanPersonalData.js           # report only, changes nothing
//   node cron/orphanPersonalData.js --apply   # delete the leftovers
//
// Safety:
// - A record is removed only when its account id matches NO influencer, brand,
//   photographer or admin — or matches an anonymized account.
// - Refuses to run if it finds no accounts at all (wrong database).
// - Never touches payments, campaign transactions, subscriptions or invites.
// - Prints counts only (no personal data).

try { require('dotenv').config(); } catch { /* optional */ }
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

// Same list as src/users/personal-traces.ts — keep both the same.
const PERSONAL_TRACES = [
  ['notifications', 'userId', 'string'],
  ['pushsubscriptions', 'userId', 'string'],
  ['notificationpreferences', 'userId', 'string'],
  ['profile_flags', 'userId', 'string'],
  ['collaboration_sync_status', 'userId', 'string'],
  ['social_account_observations', 'profileId', 'string'],
  ['social_account_observation_history', 'profileId', 'string'],
  ['social_account_verifications', 'profileId', 'string'],
  ['social_account_reviews', 'profileId', 'string'],
  ['profile_traffic_daily', 'profileId', 'string'],
  ['social_profile_clicks', 'targetUserId', 'objectId'],
];

async function findOrphans(db) {
  const live = new Set();
  const anonymized = new Set();
  for (const name of ['influencers', 'brands', 'photographers', 'users']) {
    for (const d of await db.collection(name).find({}, { projection: { _id: 1, anonymized: 1 } }).toArray()) {
      (d.anonymized === true ? anonymized : live).add(String(d._id));
    }
  }
  if (!live.size) throw new Error('No accounts found — is MONGODB_URI the right database?');
  const report = [];
  for (const [collection, field] of PERSONAL_TRACES) {
    const rows = await db
      .collection(collection)
      .find({ [field]: { $exists: true, $nin: [null, ''] } }, { projection: { [field]: 1 } })
      .toArray();
    const gone = rows.filter((r) => !live.has(String(r[field])));
    report.push({
      collection,
      field,
      total: rows.length,
      ids: gone.map((r) => r._id),
      accounts: new Set(gone.map((r) => String(r[field]))).size,
      anonymizedRows: gone.filter((r) => anonymized.has(String(r[field]))).length,
    });
  }
  return { liveAccounts: live.size, anonymizedAccounts: anonymized.size, report };
}

async function run(db, { apply }) {
  const { liveAccounts, anonymizedAccounts, report } = await findOrphans(db);
  console.log(`Accounts: ${liveAccounts} live, ${anonymizedAccounts} anonymized.`);
  let removed = 0;
  for (const r of report) {
    let note = '';
    if (apply && r.ids.length) {
      const res = await db.collection(r.collection).deleteMany({ _id: { $in: r.ids } });
      removed += res.deletedCount;
      note = ` → deleted ${res.deletedCount}`;
    }
    console.log(
      `  ${r.collection.padEnd(36)} ${String(r.ids.length).padStart(5)} of ${String(r.total).padStart(5)} left behind by ${r.accounts} account(s)${r.anonymizedRows ? ` (${r.anonymizedRows} of anonymized)` : ''}${note}`,
    );
  }
  const found = report.reduce((n, r) => n + r.ids.length, 0);
  console.log(apply ? `Deleted ${removed} records.` : `Found ${found} records. Report only — add --apply to delete them.`);
  return { found, removed };
}

module.exports = { run, PERSONAL_TRACES };

if (require.main === module) {
  (async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');
    await mongoose.connect(process.env.MONGODB_URI);
    try {
      await run(mongoose.connection.db, { apply: APPLY });
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
