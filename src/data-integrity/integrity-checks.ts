import { normalizeUtr } from "../utils/utr.util";
import { ObjectId, type Db } from "mongodb";
import { PERSONAL_TRACES } from "../users/personal-traces";
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
 * TrendStarZ credit is a ledger: every issued lot must equal what's still on it plus
 * what was spent (not given back), taken back, and expired.
 */
async function creditLedgerAddsUp(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const n = (v: unknown) => Math.round(Number(v || 0));
  const lots = await db
    .collection("platform_credits")
    .find({ type: "issued" }, { projection: { amount: 1, remaining: 1, ownerId: 1 } })
    .toArray();
  const moves = await db
    .collection("platform_credits")
    .find(
      { type: { $in: ["used", "reversed", "expired"] }, lotId: { $ne: null } },
      { projection: { type: 1, amount: 1, lotId: 1, restoredAt: 1 } },
    )
    .toArray();
  const out = new Map<string, number>();
  for (const m of moves as any[]) {
    if (m.type === "used" && m.restoredAt) continue; // given back to the lot
    const key = String(m.lotId);
    out.set(key, (out.get(key) || 0) + n(m.amount));
  }
  const found: Array<{ ref: string; text: string }> = [];
  for (const lot of lots as any[]) {
    const accounted = n(lot.remaining) + (out.get(String(lot._id)) || 0);
    if (accounted !== n(lot.amount) || n(lot.remaining) < 0) {
      found.push({
        ref: `platform_credits:${lot._id}`,
        text: `credit lot ${lot._id} (owner ${lot.ownerId}): issued ${n(lot.amount)} ≠ left ${n(lot.remaining)} + spent/taken back/expired ${out.get(String(lot._id)) || 0} (paise)`,
      });
    }
  }
  return explainableCheck(
    "credit_ledger_adds_up",
    "TrendStarZ credit adds up",
    "A credit lot's balance doesn't match its history (spent, taken back, expired). Check the host's credit in Payments; if it's right as recorded (e.g. an early manual adjustment), mark it as explained.",
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

/**
 * A paid TrendScore re-analysis must produce a paid audit. Approved payments
 * older than 15 minutes with no paid audit since mean the creator was charged
 * and got nothing (the next verify/webhook retries; this makes it visible).
 */
async function paidRescoreDelivered(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const payments = await db
    .collection("payments")
    .find(
      {
        purpose: "collab_score_reanalysis",
        status: "approved",
        reanalysisDeliveredAt: { $in: [null] },
        gatewayVerifiedAt: { $lt: cutoff },
      },
      { projection: { userId: 1, gatewayVerifiedAt: 1, orderId: 1 } },
    )
    .toArray();
  const found: Array<{ ref: string; text: string }> = [];
  for (const p of payments as any[]) {
    const since = new Date(new Date(p.gatewayVerifiedAt).getTime() - 60_000);
    const delivered = await db
      .collection("collaboration_audits")
      .countDocuments({ userId: String(p.userId), isPaid: true, createdAt: { $gte: since } }, { limit: 1 });
    if (!delivered) {
      found.push({ ref: String(p._id), text: `payment ${p._id} (order ${p.orderId || "?"}) for user ${p.userId}` });
    }
  }
  return explainableCheck(
    "paid_rescore_delivered",
    "Paid TrendScore re-analyses were delivered",
    "A creator paid for a TrendScore re-analysis but no new score was produced (it is retried when they reopen the page or Razorpay resends the payment). Run a new score from that user's admin TrendScore page, or refund, then mark it as explained.",
    found,
    explained,
  );
}

/** Invite statuses with nothing left to do (the rest still expect the campaign). */
const CLOSED_INVITE_STATUSES = ["declined", "withdrawn", "expired", "cancelled", "completed", "approved", "rejected"];

/**
 * Records that point to something that no longer exists, where it still
 * matters: an open/accepted invite whose campaign is gone (the creator sees
 * work that can't happen), and a payment whose invite is gone while its payout
 * or refund is still unsettled (it can never be completed from the app).
 */
async function danglingReferences(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const campaignIds = new Set(
    (await db.collection("campaigns").find({}, { projection: { _id: 1 } }).toArray()).map((c: any) => String(c._id)),
  );
  const found: Array<{ ref: string; text: string }> = [];
  const openInvites = await db
    .collection("campaigninvites")
    .find({ status: { $nin: CLOSED_INVITE_STATUSES } }, { projection: { campaignId: 1, status: 1 } })
    .toArray();
  for (const inv of openInvites as any[]) {
    if (!campaignIds.has(String(inv.campaignId))) {
      found.push({ ref: `invite:${inv._id}`, text: `${inv.status} invite ${inv._id} → campaign ${inv.campaignId} no longer exists` });
    }
  }
  const unsettled = await db
    .collection("campaigntransactions")
    .find(
      {
        transactionType: { $ne: "platform_fee" },
        collectionStatus: "verified",
        $or: [{ payoutStatus: { $in: ["pending", "processing", "frozen"] } }, { refundStatus: { $in: ["on_hold", "owed"] } }],
      },
      { projection: { inviteId: 1, payoutStatus: 1, refundStatus: 1, payerTotal: 1 } },
    )
    .toArray();
  for (const tx of unsettled as any[]) {
    const exists = tx.inviteId
      ? await db.collection("campaigninvites").countDocuments({ _id: tx.inviteId }, { limit: 1 })
      : 0;
    if (!exists) {
      found.push({
        ref: `tx:${tx._id}`,
        text: `payment ${tx._id} (₹${Math.round(Number(tx.payerTotal || 0) / 100)}, payout ${tx.payoutStatus}, refund ${tx.refundStatus || "none"}) → its invite no longer exists`,
      });
    }
  }
  return explainableCheck(
    "dangling_references",
    "Open work and unsettled money point to existing records",
    "An open invite's campaign, or an unsettled payment's invite, was deleted. Settle the money (pay out, refund, or mark the payout skipped in Payments) or close the invite; test data can be marked as explained.",
    found,
    explained,
  );
}

/** The nightly encrypted backup ran successfully within the last 36 hours. */
async function recentBackup(db: Db): Promise<IntegrityCheck> {
  const last: any = await db
    .collection("database_backups")
    .find({ status: "ok" })
    .sort({ at: -1 })
    .limit(1)
    .next()
    .catch(() => null);
  const ageHours = last?.at ? (Date.now() - new Date(last.at).getTime()) / 3600000 : Infinity;
  const keySet = /^[0-9a-f]{64}$/i.test(String(process.env.BACKUP_ENCRYPTION_KEY || "").trim());
  const problem = !keySet
    ? "Backups are off: BACKUP_ENCRYPTION_KEY is not set in Railway."
    : ageHours > 36
      ? last
        ? `Last successful backup was ${Math.round(ageHours)} hours ago.`
        : "No successful backup yet — press \"Back up now\" below."
      : "";
  return check(
    "recent_backup",
    "A database backup was made in the last 36 hours",
    problem ? 1 : 0,
    "The free Atlas plan keeps no backups, so the nightly encrypted backup is the only way to undo a mistake. Fix the setting or press \"Back up now\" on this page.",
    problem ? [problem] : [],
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

/**
 * Personal records (flags, notifications, social checks, statistics) whose
 * account no longer exists or was anonymized. Account deletion removes them;
 * anything found here was left by an older deletion or a failed cleanup step.
 */
async function personalDataAfterDelete(db: Db): Promise<IntegrityCheck> {
  const live: string[] = [];
  for (const name of ["influencers", "brands", "photographers", "users"]) {
    const rows = await db.collection(name).find({ anonymized: { $ne: true } }, { projection: { _id: 1 } }).toArray();
    for (const r of rows) live.push(String(r._id));
  }
  const samples: string[] = [];
  let total = 0;
  if (live.length) {
    for (const [collection, field, idType] of PERSONAL_TRACES) {
      const ids = idType === "objectId" ? live.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) : live;
      const n = await db.collection(collection).countDocuments({ [field]: { $exists: true, $nin: [null, "", ...ids] } });
      if (n) {
        total += n;
        samples.push(`${collection}: ${n}`);
      }
    }
  }
  return check(
    "personal_data_after_delete",
    "Deleted accounts left no personal records behind",
    total,
    "Flags, notifications or social checks still exist for accounts that were deleted or anonymized. Clear them with: node cron/orphanPersonalData.js --apply",
    samples,
  );
}

/**
 * Every collected payment must be on its way somewhere: paid out, refunded, or
 * waiting in a queue that leads there. Stuck = verified, not paid out, no refund
 * started, and the collaboration can no longer pay the creator (closed without
 * completing, or a dispute closed without an outcome). Missing invites are
 * reported by dangling_references instead.
 */
async function collectedMoneySettles(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const txs = await db
    .collection("campaigntransactions")
    .find(
      {
        transactionType: { $ne: "platform_fee" },
        collectionStatus: "verified",
        payoutStatus: { $nin: ["paid", "skipped"] },
        refundStatus: { $in: [null, "none"] },
      },
      { projection: { inviteId: 1, payerTotal: 1, createdAt: 1 } },
    )
    .toArray();
  const found: Array<{ ref: string; text: string }> = [];
  for (const tx of txs as any[]) {
    if (!tx.inviteId) continue;
    const inv: any = await db
      .collection("campaigninvites")
      .findOne({ _id: tx.inviteId }, { projection: { status: 1, "reportedIssue.resolvedAt": 1 } });
    if (!inv) continue;
    const why = ["withdrawn", "declined", "expired", "cancelled", "rejected"].includes(inv.status)
      ? `invite is ${inv.status}`
      : inv.status === "disputed" && inv.reportedIssue?.resolvedAt
        ? "dispute was closed without deciding pay or refund"
        : "";
    if (why) {
      found.push({
        ref: `tx:${tx._id}`,
        text: `payment ${tx._id} (₹${Math.round(Number(tx.payerTotal || 0) / 100)}): ${why}, but it is neither paid out nor refunded`,
      });
    }
  }
  return explainableCheck(
    "collected_money_settles",
    "Every collected payment is paid out or refunded",
    "The host paid, but the collaboration can no longer pay the creator and no refund was started. Decide it in Disputes (Resolve as completed / withdrawn) or refund it in Payments; ₹1 test payments can be marked as explained.",
    found,
    explained,
  );
}

/** Invites still waiting for a reply under a campaign that has already ended. */
async function invitesCloseWithCampaign(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const closed = new Map(
    (
      await db
        .collection("campaigns")
        .find({ status: { $in: ["completed", "cancelled", "rejected"] } }, { projection: { status: 1, campaignNumber: 1 } })
        .toArray()
    ).map((c: any) => [String(c._id), c]),
  );
  const found: Array<{ ref: string; text: string }> = [];
  const waiting = await db
    .collection("campaigninvites")
    .find({ status: { $in: ["pending", "invited", "counter_sent"] } }, { projection: { campaignId: 1, status: 1 } })
    .toArray();
  for (const inv of waiting as any[]) {
    const c: any = closed.get(String(inv.campaignId));
    if (c) {
      found.push({
        ref: `invite:${inv._id}`,
        text: `${inv.status} invite ${inv._id} → campaign ${c.campaignNumber ?? inv.campaignId} is ${c.status}`,
      });
    }
  }
  return explainableCheck(
    "invites_close_with_campaign",
    "No invite waits for a reply on an ended campaign",
    "These still count as 'needs your response' for the creator. Close them with: node cron/backfillNeverAcceptedInvitesForClosedCampaigns.js --apply",
    found,
    explained,
  );
}

const ACCOUNT_COLLECTIONS: Array<[collection: string, label: string]> = [
  ["influencers", "influencer"],
  ["brands", "brand"],
  ["photographers", "photographer"],
];

/**
 * The two approval fields say the same thing, and an approved account is
 * active. A profile save once flipped approval silently (2026-10-25), and a
 * half-applied admin action could leave the fields disagreeing.
 */
async function approvalFieldsAgree(db: Db, explained: ExplainedSet): Promise<IntegrityCheck> {
  const found: Array<{ ref: string; text: string }> = [];
  for (const [collection, label] of ACCOUNT_COLLECTIONS) {
    const rows = await db
      .collection(collection)
      .find(
        {
          isDeleted: { $ne: true },
          anonymized: { $ne: true },
          $or: [
            { verificationStatus: "approved", verifiedByTrendStarz: { $ne: true } },
            { verifiedByTrendStarz: true, verificationStatus: { $ne: "approved" } },
            {
              $or: [{ verificationStatus: "approved" }, { verifiedByTrendStarz: true }],
              status: { $nin: ["accepted", "deleted", "deletion_pending", "suspended"] },
            },
          ],
        },
        { projection: { email: 1, status: 1, verificationStatus: 1, verifiedByTrendStarz: 1 } },
      )
      .toArray();
    for (const r of rows as any[]) {
      found.push({
        ref: `${collection}:${r._id}`,
        text: `${label} ${r.email || r._id}: verification ${r.verificationStatus || "—"}, TrendStarZ-verified ${!!r.verifiedByTrendStarz}, account ${r.status || "—"}`,
      });
    }
  }
  return explainableCheck(
    "approval_fields_agree",
    "Approval fields agree with each other",
    "An account's approval fields disagree (approved in one place, not in the other), or an approved account isn't active. Open it in Admin → Users and set the approval again; if it is right as it stands, mark it as explained.",
    found,
    explained,
  );
}

/** Every live account has its INF / BRD / PHO number (admin search and references use it). */
async function publicIdsPresent(db: Db): Promise<IntegrityCheck> {
  const samples: string[] = [];
  let total = 0;
  for (const [collection] of ACCOUNT_COLLECTIONS) {
    const n = await db.collection(collection).countDocuments({
      isDeleted: { $ne: true },
      $or: [{ publicId: { $exists: false } }, { publicId: null }, { publicId: "" }],
    });
    if (n) {
      total += n;
      samples.push(`${collection}: ${n}`);
    }
  }
  return check(
    "public_ids_present",
    "Every account has its ID number",
    total,
    "Some accounts have no INF / BRD / PHO number. New accounts get one automatically; give the rest theirs with: node cron/backfillPublicIds.js --apply",
    samples,
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
    creditLedgerAddsUp(db, explained),
    paidRescoreDelivered(db, explained),
    danglingReferences(db, explained),
    recentBackup(db),
    personalDataAfterDelete(db),
    collectedMoneySettles(db, explained),
    invitesCloseWithCampaign(db, explained),
    approvalFieldsAgree(db, explained),
    publicIdsPresent(db),
  ]);
}
