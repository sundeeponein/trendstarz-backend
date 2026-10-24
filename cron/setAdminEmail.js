// Changes the admin account's login email (the admin has no profile screen for it).
// The new address receives admin sign-in alerts, security alerts and password resets.
//
// Usage (from trendstarz-backend/):
//   node cron/setAdminEmail.js new@example.com            # shows what would change
//   node cron/setAdminEmail.js new@example.com --apply    # changes it
//
// Refuses if the address is already used by any account (influencer, brand,
// photographer or admin). Tip: a Gmail "plus" address (you+admin@gmail.com)
// reaches your normal inbox but counts as a different address here.
// Env: MONGODB_URI (read from .env when present).

try { require('dotenv').config(); } catch { /* optional */ }
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const newEmail = String(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || '').trim().toLowerCase();

(async () => {
  if (!process.env.MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) {
    console.error('Give the new email, e.g.: node cron/setAdminEmail.js you+admin@gmail.com');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const admins = await db.collection('users').find({ role: 'admin' }, { projection: { email: 1 } }).toArray();
  if (admins.length !== 1) {
    console.error(`Expected exactly one admin account, found ${admins.length} — change it by hand.`);
    process.exit(1);
  }
  const admin = admins[0];
  for (const c of ['users', 'influencers', 'brands', 'photographers']) {
    const taken = await db.collection(c).findOne({ email: newEmail, _id: { $ne: admin._id } }, { projection: { _id: 1 } });
    if (taken) {
      console.error(`${newEmail} is already used by ${c} ${taken._id} — pick another (e.g. a +admin Gmail address).`);
      process.exit(1);
    }
  }

  console.log(`Admin ${admin._id}: "${admin.email}" -> "${newEmail}"${APPLY ? '' : '  (report only — add --apply)'}`);
  if (APPLY) {
    await db.collection('users').updateOne(
      { _id: admin._id, email: admin.email },
      { $set: { email: newEmail, previousVerifiedEmail: admin.email, isEmailVerified: true, emailVerifiedAt: new Date() } },
    );
    console.log('Done. Sign in to the admin panel with the new email from now on (same password).');
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err?.message || err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
