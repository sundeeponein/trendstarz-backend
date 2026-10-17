// cron/backfillPaymentAmountPaise.js
//
// Fills payments.amountPaise (always paise) on rows written before the field
// existed. Payment.amount kept its legacy unit: Razorpay rows paise, manual
// UPI rows rupees — same rule as src/payment/payment-amount.util.ts.
//
// Safety:
// - Dry-run by default (no writes unless --apply is provided).
// - Only sets amountPaise where it is missing; never changes amount.
//
// Usage:
//   MONGODB_URI=mongodb://... node cron/backfillPaymentAmountPaise.js
//   MONGODB_URI=mongodb://... node cron/backfillPaymentAmountPaise.js --apply

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const APPLY = process.argv.includes('--apply');
const TAG = '[backfill-payment-amount-paise]';

function legacyPaise(row) {
  const amount = Number(row.amount || 0);
  if (!Number.isFinite(amount)) return null;
  const razorpay = row.gatewayProvider === 'razorpay' || row.paymentMethod === 'razorpay';
  return razorpay ? Math.round(amount) : Math.round(amount * 100);
}

async function run() {
  if (!MONGODB_URI || !/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) {
    throw new Error('MONGODB_URI is missing or invalid');
  }
  await mongoose.connect(MONGODB_URI);
  const payments = mongoose.connection.db.collection('payments');
  console.log(`${TAG} mode=${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const rows = await payments
    .find({ amountPaise: { $exists: false } })
    .project({ amount: 1, gatewayProvider: 1, paymentMethod: 1, purpose: 1, status: 1 })
    .toArray();

  const ops = [];
  const byKind = {};
  for (const row of rows) {
    const paise = legacyPaise(row);
    const kind = `${row.gatewayProvider || row.paymentMethod || 'unknown'}/${row.purpose || 'subscription'}`;
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (paise === null) {
      console.log(`${TAG} skip ${row._id}: amount=${row.amount} is not a number`);
      continue;
    }
    if (ops.length < 10) {
      console.log(`${TAG} sample ${row._id} ${kind} amount=${row.amount} -> amountPaise=${paise}`);
    }
    ops.push({
      updateOne: {
        filter: { _id: row._id, amountPaise: { $exists: false } },
        update: { $set: { amountPaise: paise } },
      },
    });
  }
  console.log(`${TAG} rows missing amountPaise: ${rows.length}`, byKind);

  if (!APPLY || !ops.length) {
    if (!APPLY) console.log(`${TAG} dry run only; no writes performed`);
    await mongoose.disconnect();
    return;
  }
  const result = await payments.bulkWrite(ops, { ordered: false });
  console.log(`${TAG} updated: ${result.modifiedCount}`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`${TAG} error:`, err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
