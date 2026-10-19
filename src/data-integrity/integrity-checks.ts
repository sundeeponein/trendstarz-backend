import { normalizeUtr } from "../utils/utr.util";
import type { Db } from "mongodb";
import { ACTIVE_INVITE_STATUSES } from "../campaigns/reinvite-rule.util";
import { isActivePremium } from "../payments-payouts/fee-rates.util";

/**
 * Read-only checks for the data rules the platform relies on (2026-10-17
 * foundation work). Each returns a count of rows breaking the rule plus a few
 * sample ids. Nothing here writes. Run nightly and on demand from the admin
 * "Data health" page (see DataIntegrityService).
 */
export type CheckStatus = "ok" | "warn";

export interface IntegrityCheck {
  key: string;
  label: string;
  status: CheckStatus;
  count: number;
  /** What a non-zero count means and what to do. */
  help: string;
  samples: string[];
  /** Explainable checks: one stable reference per sample (same order), for "Mark as explained". */
  refs?: string[];
  /** How many matching records an admin already explained (not counted above). */
  explained?: number;
}

/** "<check>:<ref>" keys an admin marked as explained (collection data_integrity_explanations). */
export type ExplainedSet = Set<string>;
export const EXPLANATIONS = "data_integrity_explanations";

export async function loadExplained(db: Db): Promise<ExplainedSet> {
  const rows = await db
    .collection(EXPLANATIONS)
    .find({}, { projection: { check: 1, ref: 1 } })
    .toArray();
  return new Set(rows.map((r: any) => `${r.check}:${r.ref}`));
}

/** Builds an explainable check from its matching records, leaving out explained ones. */
function explainableCheck(
  key: string,
  label: string,
  help: string,
  found: Array<{ ref: string; text: string }>,
  explained: ExplainedSet,
): IntegrityCheck {
  const open = found.filter((f) => !explained.has(`${key}:${f.ref}`));
  const result = check(key, label, open.length, help, open.map((f) => f.text));
  result.refs = open.slice(0, SAMPLE_LIMIT).map((f) => f.ref);
  result.explained = found.length - open.length;
  return result;
}

const SAMPLE_LIMIT = 5;
const HEX24 = /^[a-f0-9]{24}$/i;

/** Field → the one BSON type every stored value must have (schemas were locked to these). */
export const ID_TYPE_RULES: Array<[collection: string, field: string, type: "string" | "objectId"]> = [
  ["campaigns", "brandId", "string"],
  ["campaigninvites", "campaignId", "string"],
  ["campaigninvites", "brandId", "string"],
  ["campaigninvites", "influencerId", "objectId"],
  ["campaignsubmissions", "campaignId", "string"],
  ["campaignsubmissions", "influencerId", "objectId"],
  ["campaignsubmissions", "inviteId", "objectId"],
  ["campaigntransactions", "campaignId", "string"],
  ["campaigntransactions", "inviteId", "objectId"],
  ["campaigntransactions", "payerId", "string"],
  ["campaigntransactions", "recipientId", "string"],
  ["campaigntransactions", "feeInviteId", "objectId"],
  ["trackinglinks", "campaignId", "string"],
  ["trackinglinks", "inviteId", "string"],
  ["trackinglinks", "recipientId", "string"],
  ["trackinglinks", "hostId", "string"],
  ["profile_flags", "userId", "string"],
];

/** Money fields that must never be negative (paise, except where noted in the schemas). */
export const MONEY_RULES: Record<string, string[]> = {
  campaigntransactions: ["agreedAmount", "platformFee", "payerTotal", "recipientFee", "recipientPayout", "gstAmount", "refundAmount", "creditApplied", "compensation.amount", "settlement.amount"],
  payments: ["amount", "amountPaise", "refundAmount"],
  campaigninvites: ["agreedAmount", "agreedAmountPaise", "platformFeeDue", "counterOffer.requestedAmountPaise", "cancelRequest.compensationAmount"],
  campaigns: ["pricePerInfluencer", "budgetMin", "budgetMax", "estimatedBudget", "productValue"],
  platform_credits: ["amount", "remaining"],
};

export const REQUIRED_INDEXES: Array<[collection: string, name: string]> = [
  ["campaigninvites", "uniq_active_invite_per_recipient"],
  ["reviews", "uniq_review_per_invite_side"],
  ["campaignsubmissions", "uniq_submission_per_invite"],
];

function check(
  key: string,
  label: string,
  count: number,
  help: string,
  samples: string[] = [],
): IntegrityCheck {
  return {
    key,
    label,
    status: count > 0 ? "warn" : "ok",
    count,
    help,
    samples: samples.slice(0, SAMPLE_LIMIT),
  };
}

async function hasCollection(db: Db, name: string) {
  return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

async function idTypes(db: Db): Promise<IntegrityCheck> {
  let count = 0;
  const samples: string[] = [];
  for (const [col, field, type] of ID_TYPE_RULES) {
    const filter = {
      [field]: { $exists: true, $ne: null, $not: { $type: type } },
    };
    const n = await db.collection(col).countDocuments(filter);
    if (n) {
      count += n;
      samples.push(`${col}.${field}: ${n} not ${type}`);
    }
    if (type === "string") {
      // Ids stored as strings must still be 24-hex ids (no usernames etc.).
      const bad = await db.collection(col).countDocuments({
        [field]: { $type: "string", $not: HEX24 },
      });
      if (bad) {
        count += bad;
        samples.push(`${col}.${field}: ${bad} not a 24-hex id`);
      }
    }
  }
  return check(
    "id_types",
    "ID fields hold one consistent type",
    count,
    "Rows whose id is stored in a different type than the schema expects — queries may silently miss them. Usually written by a script that bypassed the schema.",
    samples,
  );
}

async function requiredIndexes(db: Db): Promise<IntegrityCheck> {
  const missing: string[] = [];
  for (const [col, name] of REQUIRED_INDEXES) {
    const present = (await hasCollection(db, col))
      ? (await db.collection(col).indexes()).some((i) => i.name === name)
      : false;
    if (!present) missing.push(`${col}.${name}`);
  }
  return check(
    "unique_indexes",
    "Uniqueness indexes are in place",
    missing.length,
    "A database uniqueness rule is missing. Run: npm run audit:unique-constraints, then npm run apply:unique-constraints.",
    missing,
  );
}

async function duplicateActiveInvites(db: Db): Promise<IntegrityCheck> {
  const rows = await db
    .collection("campaigninvites")
    .aggregate([
      { $match: { status: { $in: [...ACTIVE_INVITE_STATUSES] } } },
      {
        $group: {
          _id: {
            campaignId: { $toString: "$campaignId" },
            influencerId: { $toString: "$influencerId" },
          },
          n: { $sum: 1 },
          ids: { $push: { $toString: "$_id" } },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  return check(
    "duplicate_active_invites",
    "One active invite per campaign + creator",
    rows.length,
    "The same creator holds more than one active invite on a campaign. Withdraw the extra one.",
    rows.map((r: any) => r.ids.join(" + ")),
  );
}

async function negativeMoney(db: Db): Promise<IntegrityCheck> {
  let count = 0;
  const samples: string[] = [];
  for (const [col, fields] of Object.entries(MONEY_RULES)) {
    for (const f of fields) {
      const n = await db.collection(col).countDocuments({ [f]: { $lt: 0 } });
      if (n) {
        count += n;
        samples.push(`${col}.${f}: ${n}`);
      }
    }
  }
  return check(
    "negative_money",
    "No negative money amounts",
    count,
    "A money field holds a negative value. The schema rejects these on save, so they came from a direct database write.",
    samples,
  );
}

async function paymentsMissingPaise(db: Db): Promise<IntegrityCheck> {
  const ids = await db
    .collection("payments")
    .find({ amountPaise: { $exists: false } }, { projection: { _id: 1 } })
    .limit(SAMPLE_LIMIT)
    .toArray();
  const n = await db.collection("payments").countDocuments({ amountPaise: { $exists: false } });
  return check(
    "payments_amount_paise",
    "Every payment has amountPaise",
    n,
    "Older payment rows without the explicit paise amount. Run: npm run backfill:payment-amount-paise (dry run), then with :apply.",
    ids.map((r) => String(r._id)),
  );
}

async function slotRacePairs(db: Db): Promise<IntegrityCheck> {
  const rows = await db
    .collection("campaigns")
    .find({ slotUsedAt: { $ne: null } }, { projection: { brandId: 1, slotUsedAt: 1, campaignNumber: 1 } })
    .sort({ brandId: 1, slotUsedAt: 1 })
    .toArray();
  const samples: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a: any = rows[i - 1];
    const b: any = rows[i];
    if (
      String(a.brandId) === String(b.brandId) &&
      new Date(b.slotUsedAt).getTime() - new Date(a.slotUsedAt).getTime() < 5000
    ) {
      samples.push(`host ${a.brandId}: CMP-${a.campaignNumber} + CMP-${b.campaignNumber}`);
    }
  }
  return check(
    "slot_race_pairs",
    "No two campaigns took a monthly slot at the same moment",
    samples.length,
    "One host's campaigns took slots within 5 seconds — a double submit may have passed the monthly limit. If this appears, build the per-host slot counter.",
    samples,
  );
}

async function unexplainedPremium(
  db: Db,
  explained: ExplainedSet,
): Promise<IntegrityCheck> {
  const found: Array<{ ref: string; text: string }> = [];
  for (const col of ["influencers", "brands", "photographers"]) {
    const users = await db
      .collection(col)
      .find({ isPremium: true, premiumSource: { $ne: "admin" } }, { projection: { email: 1 } })
      .toArray();
    for (const u of users) {
      const paid = await db.collection("payments").countDocuments({
        userId: u._id,
        $or: [{ status: "approved" }, { paymentStatus: "captured" }],
      });
      if (!paid) {
        const ref = `${col}:${u._id}`;
        found.push({ ref, text: `${ref} ${u.email || ""}`.trim() });
      }
    }
  }
  return explainableCheck(
    "unexplained_premium",
    "Every Premium account has a payment or an admin grant",
    "Premium without an approved payment and not marked as an admin grant. Check the account; if you granted it, set premiumSource to \"admin\".",
    found,
    explained,
  );
}

async function unlockedWithoutPayment(
  db: Db,
  explained: ExplainedSet,
): Promise<IntegrityCheck> {
  const invites = await db
    .collection("campaigninvites")
    .find(
      { unlocked: true, unlockType: "paid_collab_payment", paymentConfirmedAt: { $in: [null] } },
      { projection: { _id: 1 } },
    )
    .toArray();
  const found: Array<{ ref: string; text: string }> = [];
  for (const inv of invites) {
    const verified = await db.collection("campaigntransactions").countDocuments({
      inviteId: inv._id,
      collectionStatus: "verified",
    });
    if (!verified) found.push({ ref: String(inv._id), text: String(inv._id) });
  }
  return explainableCheck(
    "unpaid_unlocks",
    "Paid-collab contact unlocks have a verified payment",
    "A creator's contact was unlocked as paid without any verified payment. Check the campaign (test data is a common cause). If it was settled outside the app, mark it as explained.",
    found,
    explained,
  );
}

const COLLECTION_BY_USER_TYPE: Record<string, string> = {
  INFLUENCER: "influencers",
  BRAND: "brands",
  PHOTOGRAPHER: "photographers",
};

/**
 * Premium lives in two places: the subscriptions collection (what plan features
 * use) and isPremium/premiumEnd on the profile (what the app shows). An active
 * subscription on a profile that isn't Premium means the user gets features
 * the app says they don't have — e.g. Premium removed directly in the database.
 */
async function premiumSourcesAgree(
  db: Db,
  explained: ExplainedSet,
  now = new Date(),
): Promise<IntegrityCheck> {
  const subs = await db
    .collection("subscriptions")
    .find({ status: "active", endDate: { $gte: now } }, { projection: { userId: 1, userType: 1, endDate: 1, source: 1 } })
    .toArray();
  const found: Array<{ ref: string; text: string }> = [];
  for (const sub of subs as any[]) {
    const col = COLLECTION_BY_USER_TYPE[String(sub.userType)] || "influencers";
    const user: any = await db
      .collection(col)
      .findOne({ _id: sub.userId }, { projection: { email: 1, isPremium: 1, premiumEnd: 1 } });
    const subEnd = new Date(sub.endDate);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (!isActivePremium(user, now)) {
      found.push({
        ref: `subscriptions:${sub._id}`,
        text: `${col}:${sub.userId} ${user?.email || "(no profile)"} — subscription active until ${day(subEnd)}, profile not Premium`,
      });
    } else if (
      user?.premiumEnd &&
      subEnd.getTime() - new Date(user.premiumEnd).getTime() > 24 * 3600 * 1000
    ) {
      // Paid bonus months the profile didn't get (fixed 2026-10-18 for new payments).
      found.push({
        ref: `subscriptions:${sub._id}`,
        text: `${col}:${sub.userId} ${user?.email || ""} — profile Premium ends ${day(new Date(user.premiumEnd))}, subscription ${day(subEnd)}`,
      });
    }
  }
  return explainableCheck(
    "premium_sources_agree",
    "Subscriptions and profiles agree on Premium",
    "The subscription (plan features) and the profile (Pro badge, visibility) disagree: either the profile isn't Premium, or its Premium ends before the subscription (bonus months not carried over). Use the admin Premium toggle, or sync the profile end date to the subscription.",
    found,
    explained,
  );
}

/**
 * The invite and its payment row are updated in separate steps in a few flows;
 * this catches them drifting apart (e.g. a crash between the two writes).
 */
async function invitePaymentAgree(
  db: Db,
  explained: ExplainedSet,
): Promise<IntegrityCheck> {
  const txs = await db
    .collection("campaigntransactions")
    .find(
      {
        transactionType: "paid_collab",
        $or: [{ payoutStatus: "paid" }, { collectionStatus: "verified" }],
      },
      { projection: { inviteId: 1, payoutStatus: 1, collectionStatus: 1 } },
    )
    .toArray();
  const found: Array<{ ref: string; text: string }> = [];
  for (const tx of txs as any[]) {
    const inv: any = await db
      .collection("campaigninvites")
      .findOne({ _id: tx.inviteId }, { projection: { status: 1, paidOutAt: 1 } });
    let problem = "";
    if (!inv) problem = "payment row points at an invite that doesn't exist";
    else if (tx.payoutStatus === "paid" && !inv.paidOutAt) problem = "creator paid out but the invite has no payout time";
    else if (tx.collectionStatus === "verified" && inv.status === "accepted") problem = "host payment verified but the invite is still 'accepted'";
    if (problem) {
      found.push({ ref: `campaigntransactions:${tx._id}`, text: `tx ${tx._id} (invite ${tx.inviteId}): ${problem}` });
    }
  }
  return explainableCheck(
    "invite_payment_agree",
    "Invites and their payments agree",
    "An invite and its payment row disagree about where the collaboration is. Check the collaboration in Payments; if the record is right as it stands, mark it as explained.",
    found,
    explained,
  );
}

/**
 * Every payment row must add up from its own parts (paise):
 *   paid collab   payerTotal = agreed + fee + GST − credit; payout = agreed − creator fee − its GST
 *   platform fee  payerTotal = fee + GST − credit;           payout = 0
 * plus: an invite's rupee and paise amounts agree, and a paid collab row's
 * amount equals its invite's agreed amount. Rows with an admin-awarded
 * compensation are skipped (their payout is set on purpose).
 */
async function moneyAddsUp(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const n = (v: unknown) => Math.round(Number(v || 0));
  const found: Array<{ ref: string; text: string }> = [];
  const txs = await db
    .collection("campaigntransactions")
    .find(
      { "compensation.amount": { $in: [null, 0] } },
      { projection: { transactionType: 1, inviteId: 1, agreedAmount: 1, platformFee: 1, gstAmount: 1, creditApplied: 1, payerTotal: 1, recipientFee: 1, recipientFeeGst: 1, recipientPayout: 1 } },
    )
    .toArray();
  for (const t of txs as any[]) {
    const type = String(t.transactionType || "");
    let wantTotal: number | null = null;
    let wantPayout: number | null = null;
    if (type === "paid_collab") {
      wantTotal = n(t.agreedAmount) + n(t.platformFee) + n(t.gstAmount) - n(t.creditApplied);
      wantPayout = Math.max(n(t.agreedAmount) - n(t.recipientFee) - n(t.recipientFeeGst), 0);
    } else if (type === "platform_fee") {
      wantTotal = Math.max(n(t.platformFee) + n(t.gstAmount) - n(t.creditApplied), 0);
      wantPayout = 0;
    }
    if (wantTotal === null) continue;
    const problems: string[] = [];
    if (n(t.payerTotal) !== wantTotal) problems.push(`payer total ${n(t.payerTotal)} ≠ ${wantTotal}`);
    if (n(t.recipientPayout) !== wantPayout) problems.push(`payout ${n(t.recipientPayout)} ≠ ${wantPayout}`);
    if (problems.length) {
      found.push({ ref: `campaigntransactions:${t._id}`, text: `tx ${t._id} (${type}): ${problems.join("; ")} (paise)` });
    }
  }
  // Invite amounts: rupee copy vs paise copy, and the paid collab row vs the invite.
  const invites = await db
    .collection("campaigninvites")
    .find({ agreedAmountPaise: { $gt: 0 } }, { projection: { agreedAmount: 1, agreedAmountPaise: 1 } })
    .toArray();
  const agreedByInvite = new Map<string, number>();
  for (const inv of invites as any[]) {
    agreedByInvite.set(String(inv._id), n(inv.agreedAmountPaise));
    if (inv.agreedAmount != null && Math.abs(n(inv.agreedAmount) * 100 - n(inv.agreedAmountPaise)) > 100) {
      found.push({
        ref: `campaigninvites:${inv._id}`,
        text: `invite ${inv._id}: ₹${inv.agreedAmount} ≠ ${n(inv.agreedAmountPaise)} paise`,
      });
    }
  }
  for (const t of txs as any[]) {
    if (t.transactionType !== "paid_collab") continue;
    const agreed = agreedByInvite.get(String(t.inviteId));
    if (agreed !== undefined && agreed !== n(t.agreedAmount)) {
      found.push({
        ref: `campaigntransactions:${t._id}:agreed`,
        text: `tx ${t._id}: amount ${n(t.agreedAmount)} ≠ invite's agreed ${agreed} (paise)`,
      });
    }
  }
  return explainableCheck(
    "money_adds_up",
    "Payment amounts add up",
    "A payment row's totals don't follow from its own parts (amount, fee, GST, credit), or it disagrees with its invite's agreed amount. Check it in Payments before paying out; if it's right as recorded (e.g. an old pricing rule), mark it as explained.",
    found,
    explained,
  );
}

/**
 * One bank transfer pays once: the same UTR (spaces/dashes ignored) on campaign payments
 * from different payment batches, or also on a Premium payment. Rows of one batch share
 * their UTR by design. Rejected proofs ("failed") don't count.
 */
async function utrUsedTwice(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const rows = await db
    .collection("campaigntransactions")
    .find(
      { utrNumber: { $nin: [null, ""] }, collectionStatus: { $in: ["proof_submitted", "verified"] } },
      { projection: { utrNumber: 1, paymentBatchId: 1, campaignId: 1 } },
    )
    .toArray();
  const premium = await db
    .collection("payments")
    .find({ transactionId: { $nin: [null, ""] } }, { projection: { transactionId: 1 } })
    .toArray();
  const uses = new Map<string, Set<string>>();
  const add = (utr: string, use: string) => {
    if (!utr) return;
    if (!uses.has(utr)) uses.set(utr, new Set());
    uses.get(utr)!.add(use);
  };
  for (const r of rows as any[]) {
    add(normalizeUtr(r.utrNumber), `campaign ${r.campaignId} batch ${r.paymentBatchId || r._id}`);
  }
  for (const p of premium as any[]) add(normalizeUtr(p.transactionId), `premium payment ${p._id}`);
  const found = [...uses.entries()]
    .filter(([, u]) => u.size > 1)
    .map(([utr, u]) => ({ ref: `utr:${utr}`, text: `UTR ${utr}: ${[...u].join(" · ")}` }));
  return explainableCheck(
    "utr_used_twice",
    "Each bank transfer pays once",
    "The same UTR was given for more than one payment. Check your bank statement: if it's one transfer, one of the payments wasn't really paid. If it's right (e.g. a split you agreed), mark it as explained.",
    found,
    explained,
  );
}

async function sharedEmails(db: Db): Promise<IntegrityCheck> {
  const rows = await db
    .collection("influencers")
    .aggregate([
      { $project: { email: { $toLower: { $trim: { input: { $ifNull: ["$email", ""] } } } }, src: { $literal: "influencers" } } },
      ...["brands", "photographers", "users"].map((c) => ({
        $unionWith: {
          coll: c,
          pipeline: [
            { $project: { email: { $toLower: { $trim: { input: { $ifNull: ["$email", ""] } } } }, src: { $literal: c } } },
          ],
        },
      })),
      { $match: { email: { $ne: "" } } },
      { $group: { _id: "$email", n: { $sum: 1 }, where: { $push: { $concat: ["$src", ":", { $toString: "$_id" }] } } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  return check(
    "shared_emails",
    "Each email belongs to one account",
    rows.length,
    "The same email is used by more than one account — login and password reset can reach the wrong one. Merge or change one of them.",
    rows.map((r: any) => `${r._id}: ${r.where.join(" ")}`),
  );
}

export async function runIntegrityChecks(db: Db): Promise<IntegrityCheck[]> {
  const explained = await loadExplained(db);
  return Promise.all([
    idTypes(db),
    requiredIndexes(db),
    duplicateActiveInvites(db),
    negativeMoney(db),
    paymentsMissingPaise(db),
    slotRacePairs(db),
    unexplainedPremium(db, explained),
    unlockedWithoutPayment(db, explained),
    premiumSourcesAgree(db, explained),
    invitePaymentAgree(db, explained),
    moneyAddsUp(db, explained),
    sharedEmails(db),
    utrUsedTwice(db, explained),
  ]);
}
