import type { Db } from "mongodb";
import { ACTIVE_INVITE_STATUSES } from "../campaigns/reinvite-rule.util";

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

async function unexplainedPremium(db: Db): Promise<IntegrityCheck> {
  const samples: string[] = [];
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
      if (!paid) samples.push(`${col}:${u._id} ${u.email || ""}`.trim());
    }
  }
  return check(
    "unexplained_premium",
    "Every Premium account has a payment or an admin grant",
    samples.length,
    "Premium without an approved payment and not marked as an admin grant. Check the account; if you granted it, set premiumSource to \"admin\".",
    samples,
  );
}

async function unlockedWithoutPayment(db: Db): Promise<IntegrityCheck> {
  const invites = await db
    .collection("campaigninvites")
    .find(
      { unlocked: true, unlockType: "paid_collab_payment", paymentConfirmedAt: { $in: [null] } },
      { projection: { _id: 1 } },
    )
    .toArray();
  const samples: string[] = [];
  for (const inv of invites) {
    const verified = await db.collection("campaigntransactions").countDocuments({
      inviteId: inv._id,
      collectionStatus: "verified",
    });
    if (!verified) samples.push(String(inv._id));
  }
  return check(
    "unpaid_unlocks",
    "Paid-collab contact unlocks have a verified payment",
    samples.length,
    "A creator's contact was unlocked as paid without any verified payment. Check the campaign (test data is a common cause).",
    samples,
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
  return Promise.all([
    idTypes(db),
    requiredIndexes(db),
    duplicateActiveInvites(db),
    negativeMoney(db),
    paymentsMissingPaise(db),
    slotRacePairs(db),
    unexplainedPremium(db),
    unlockedWithoutPayment(db),
    sharedEmails(db),
  ]);
}
