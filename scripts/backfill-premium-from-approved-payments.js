/**
 * One-time backfill: for every approved/captured subscription payment, make
 * sure the payer's own profile doc (isPremium/premiumStart/premiumEnd) agrees
 * with what they paid for.
 *
 * Why this is needed: verifyRazorpayPayment() used to activate the
 * `subscriptions` collection row but never set isPremium on the user's own
 * Influencer/Brand/Photographer document (the field the navbar Pro badge and
 * all visibility checks actually read). That's fixed for new payments now,
 * but any payment approved before the fix is still stuck. This script
 * derives premiumStart/premiumEnd straight from the payment record itself
 * (approvedAt/gatewayVerifiedAt + premiumDuration), so it doesn't depend on
 * whether a `subscriptions` row exists either.
 *
 * Usage:
 *   node scripts/backfill-premium-from-approved-payments.js          # apply
 *   node scripts/backfill-premium-from-approved-payments.js --dry-run # preview only
 *
 * Safe to re-run — only touches users whose current isPremium/premiumEnd
 * don't already match their latest approved payment, and never grants
 * premium for a payment whose computed period has already expired.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/trendstarz';
const DRY_RUN = process.argv.includes('--dry-run');

const USER_TYPE_TO_COLLECTION = {
  Influencer: 'influencers',
  Brand: 'brands',
  Photographer: 'photographers',
};

function addDuration(date, duration) {
  const end = new Date(date);
  if (duration === '1m') end.setMonth(end.getMonth() + 1);
  else if (duration === '3m') end.setMonth(end.getMonth() + 3);
  else if (duration === '1y') end.setFullYear(end.getFullYear() + 1);
  else return null;
  return end;
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI.replace(/:\/\/.*@/, '://***@'));
  if (DRY_RUN) console.log('--- DRY RUN: no writes will be made ---');

  const Payment = mongoose.connection.collection('payments');

  const approvedPayments = await Payment
    .find({ purpose: 'subscription', status: 'approved', paymentStatus: 'captured' })
    .sort({ createdAt: -1 })
    .toArray();

  console.log(`Found ${approvedPayments.length} approved subscription payment(s).`);

  // Keep only the most recent approved payment per (userId, userType).
  const latestByUser = new Map();
  for (const p of approvedPayments) {
    const key = `${p.userType}:${String(p.userId)}`;
    if (!latestByUser.has(key)) latestByUser.set(key, p);
  }
  console.log(`Covering ${latestByUser.size} distinct user(s).`);

  let fixed = 0;
  let alreadyOk = 0;
  let expired = 0;
  let skippedBadData = 0;

  for (const payment of latestByUser.values()) {
    const collectionName = USER_TYPE_TO_COLLECTION[payment.userType];
    if (!collectionName) {
      skippedBadData++;
      continue;
    }
    const start = new Date(payment.gatewayVerifiedAt || payment.approvedAt || payment.createdAt);
    const end = addDuration(start, payment.premiumDuration);
    if (!end) {
      console.log(`  SKIP payment ${payment._id}: unrecognized premiumDuration "${payment.premiumDuration}"`);
      skippedBadData++;
      continue;
    }
    if (end.getTime() < Date.now()) {
      expired++;
      continue; // their latest approved payment has already lapsed; don't force premium on.
    }

    const Users = mongoose.connection.collection(collectionName);
    const user = await Users.findOne(
      { _id: payment.userId },
      { projection: { isPremium: 1, premiumEnd: 1, email: 1, username: 1, brandUsername: 1, name: 1 } },
    );
    if (!user) {
      console.log(`  SKIP payment ${payment._id}: user ${payment.userId} not found in ${collectionName}`);
      skippedBadData++;
      continue;
    }

    const currentEnd = user.premiumEnd ? new Date(user.premiumEnd).getTime() : 0;
    if (user.isPremium === true && currentEnd >= end.getTime()) {
      alreadyOk++;
      continue;
    }

    const label = user.username || user.brandUsername || user.name || user.email || String(user._id);
    console.log(
      `  FIX ${payment.userType} ${label}: isPremium ${user.isPremium} -> true, ` +
      `premiumEnd ${user.premiumEnd || 'null'} -> ${end.toISOString()}`,
    );

    if (!DRY_RUN) {
      await Users.updateOne(
        { _id: payment.userId },
        {
          $set: {
            isPremium: true,
            premiumDuration: payment.premiumDuration,
            premiumStart: start,
            premiumEnd: end,
          },
        },
      );
    }
    fixed++;
  }

  console.log('\nSummary:');
  console.log(`  Fixed:        ${fixed}`);
  console.log(`  Already OK:   ${alreadyOk}`);
  console.log(`  Expired:      ${expired}`);
  console.log(`  Skipped/bad:  ${skippedBadData}`);
  if (DRY_RUN) console.log('\n(Dry run — re-run without --dry-run to apply.)');

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
