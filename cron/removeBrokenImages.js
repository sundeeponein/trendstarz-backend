// Removes profile/brand image links whose file no longer exists in Cloudinary
// (2026-11-16: 10 such links from May–July, on 2 brands and 8 influencers —
// the files are gone, so the pages showed a broken image).
//
// A link is removed ONLY when Cloudinary answers 404 for that exact file.
// Timeouts / other errors keep the link. Read-only towards Cloudinary.
//
// Fields: profileImage (+ profileImagePublicId), profileImages[], brandLogo[],
// products[] on brands, influencers and photographers.
// A creator or brand whose MAIN profile photo was removed gets a bell
// notification asking for a new one (only with --apply).
//
// Usage (from trendstarz-backend/):
//   node cron/removeBrokenImages.js           # report only
//   node cron/removeBrokenImages.js --apply   # remove the dead links
//
// Brake: stops without changing anything if more than MAX_REMOVALS links look
// missing (that would point to a Cloudinary/account problem, not dead files).

try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const axios = require('axios');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const MAX_REMOVALS = 20;
const COLLECTIONS = [
  { name: 'brands', role: 'brand', profileUrl: '/brand-profile' },
  { name: 'influencers', role: 'influencer', profileUrl: '/influencer-profile' },
  { name: 'photographers', role: 'photographer', profileUrl: '/photographer-profile' },
];
const ARRAY_FIELDS = ['profileImages', 'brandLogo', 'products'];
const LABEL = { profileImages: 'gallery photo', brandLogo: 'logo', products: 'product photo' };

const isCloudinary = (url) => typeof url === 'string' && /^https?:\/\/res\.cloudinary\.com\//.test(url);

const cache = new Map();
/** 'missing' only on a 404; anything else counts as present. */
async function fileState(url) {
  if (cache.has(url)) return cache.get(url);
  let state = 'present';
  try {
    await axios.head(url.split(/[?#]/)[0], { timeout: 15000 });
  } catch (err) {
    state = err && err.response && err.response.status === 404 ? 'missing' : 'unknown';
  }
  cache.set(url, state);
  return state;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const plan = [];
  let unknown = 0;

  for (const col of COLLECTIONS) {
    const docs = await db
      .collection(col.name)
      .find({}, { projection: { publicId: 1, username: 1, name: 1, brandName: 1, profileImage: 1, profileImages: 1, brandLogo: 1, products: 1 } })
      .toArray();
    for (const doc of docs) {
      const removals = [];
      if (isCloudinary(doc.profileImage)) {
        const s = await fileState(doc.profileImage);
        if (s === 'missing') removals.push({ field: 'profileImage', url: doc.profileImage });
        if (s === 'unknown') unknown++;
      }
      for (const field of ARRAY_FIELDS) {
        for (const item of Array.isArray(doc[field]) ? doc[field] : []) {
          if (!isCloudinary(item && item.url)) continue;
          const s = await fileState(item.url);
          if (s === 'missing') removals.push({ field, url: item.url });
          if (s === 'unknown') unknown++;
        }
      }
      if (removals.length) plan.push({ col, doc, removals });
    }
  }

  const total = plan.reduce((n, p) => n + p.removals.length, 0);
  for (const { col, doc, removals } of plan) {
    const who = `${doc.publicId || doc._id} ${doc.brandName || doc.name || doc.username || ''}`.trim();
    for (const r of removals) {
      console.log(`${col.name.padEnd(13)} ${who} — ${r.field === 'profileImage' ? 'profile photo' : LABEL[r.field]}: ${r.url.split('/').slice(-2).join('/')}`);
    }
  }
  console.log(`\nDead links: ${total} on ${plan.length} account(s). Could not check (kept): ${unknown}.`);

  if (!APPLY) {
    console.log('Report only — add --apply to remove them.');
    return;
  }
  if (total > MAX_REMOVALS) {
    console.log(`Stopped: more than ${MAX_REMOVALS} links look missing — check Cloudinary first. Nothing changed.`);
    return;
  }

  const now = new Date();
  let changed = 0;
  let notified = 0;
  for (const { col, doc, removals } of plan) {
    const update = { $set: { updatedAt: now } };
    const pull = {};
    for (const r of removals) {
      if (r.field === 'profileImage') {
        // Only clear it if it still points at the dead file.
        update.$set.profileImage = '';
        update.$set.profileImagePublicId = '';
      } else {
        (pull[r.field] ||= []).push(r.url);
      }
    }
    if (Object.keys(pull).length) {
      update.$pull = Object.fromEntries(Object.entries(pull).map(([f, urls]) => [f, { url: { $in: urls } }]));
    }
    const mainPhoto = removals.find((r) => r.field === 'profileImage');
    const filter = { _id: doc._id, ...(mainPhoto ? { profileImage: mainPhoto.url } : {}) };
    const res = await db.collection(col.name).updateOne(filter, update);
    if (!res.modifiedCount) {
      console.log(`Skipped ${doc.publicId || doc._id}: changed since the check.`);
      continue;
    }
    changed++;
    if (mainPhoto) {
      await db.collection('notifications').insertOne({
        userId: String(doc._id),
        userRole: col.role,
        title: 'Please upload your profile photo again',
        body: "Your profile photo could not be loaded, so brands see an empty picture. Upload it again from your profile — it takes a minute.",
        url: col.profileUrl,
        read: false,
        createdAt: now,
        updatedAt: now,
      });
      notified++;
    }
  }
  console.log(`Applied: ${changed} account(s) updated, ${notified} asked to upload a new profile photo.`);
}

main()
  .catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
