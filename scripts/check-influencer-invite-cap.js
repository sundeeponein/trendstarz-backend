/**
 * Read-only diagnostic: shows why a given influencer username might be
 * filtered out of the campaign "Invite Influencers" step (which applies a
 * monthly invite-received cap) while still appearing in public Search
 * (which does not apply that cap).
 *
 * Usage:
 *   node scripts/check-influencer-invite-cap.js <username>
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/trendstarz';
const username = process.argv[2];

if (!username) {
  console.error('Usage: node scripts/check-influencer-invite-cap.js <username>');
  process.exit(1);
}

function computePlanCycleStart(user, now) {
  const isPremium = !!(user.isPremium && (!user.premiumEnd || new Date(user.premiumEnd) > now));
  const anchorRaw = isPremium && user.premiumStart ? user.premiumStart : user.createdAt;
  const anchor = anchorRaw ? new Date(anchorRaw) : new Date(0);
  if (anchor > now) return { anchor, isPremium };
  const cycle = new Date(anchor);
  while (true) {
    const next = new Date(cycle);
    next.setMonth(next.getMonth() + 1);
    if (next > now) break;
    cycle.setTime(next.getTime());
  }
  return { cycle, isPremium };
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI.replace(/:\/\/.*@/, '://***@'));

  const Influencers = mongoose.connection.collection('influencers');
  const Invites = mongoose.connection.collection('campaigninvites');
  const Plans = mongoose.connection.collection('plans');

  const inf = await Influencers.findOne({ username });
  if (!inf) {
    console.log(`No influencer found with username "${username}".`);
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  const { cycle, isPremium } = computePlanCycleStart(inf, now);

  const count = await Invites.countDocuments({
    influencerId: inf._id,
    createdAt: { $gte: cycle },
  });

  const proPlan = await Plans.findOne({ code: 'influencer-pro' });
  const freePlan = await Plans.findOne({ code: 'influencer-free' });
  const proCap = proPlan?.limits?.find((l) => l.key === 'maxInvitesPerCampaign')?.value ?? 10;
  const freeCap = freePlan?.limits?.find((l) => l.key === 'maxInvitesPerCampaign')?.value ?? 1;
  const cap = isPremium ? proCap : freeCap;

  console.log('\n--- ', inf.name || username, '(@' + username + ')', '---');
  console.log('status:', inf.status, '| isPremium:', !!inf.isPremium, '| accepted-at admin:', inf.status === 'accepted');
  console.log('isEmailVerified:', inf.isEmailVerified, '| isMobileVerified:', inf.isMobileVerified);
  console.log('createdAt:', inf.createdAt, '| premiumStart:', inf.premiumStart || null);
  console.log('current monthly cycle started:', cycle.toISOString());
  console.log('invites received this cycle:', count, '/ cap', cap, isPremium ? '(pro plan)' : '(free plan)');
  console.log(
    count >= cap && cap !== -1
      ? '\n=> AT/OVER CAP: this influencer is filtered out of every brand\'s "Invite Influencers" step until the next monthly cycle, even though they remain visible in public Search.'
      : '\n=> Under cap — invite-cap filter is NOT excluding this influencer. Look elsewhere (e.g. category mismatch, location filter, gallery/verification gate).',
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
