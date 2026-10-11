/**
 * TrendStarZ credit (see database/schemas/platform-credit.schema.ts). Pure helpers over
 * the PlatformCredit model so both the payments and the invites services can use them.
 * Lots are consumed earliest-expiry first with guarded decrements, so two payments can't
 * spend the same credit.
 */
export const CREDIT_VALIDITY_MONTHS = 12;

export function creditExpiry(from: Date): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + CREDIT_VALIDITY_MONTHS);
  return d;
}

/** Unexpired credit the owner can still use (paise). */
export async function creditBalance(
  model: any,
  ownerId: string,
  now = new Date(),
): Promise<number> {
  const lots: any[] = await model
    .find({
      ownerId: String(ownerId),
      type: "issued",
      remaining: { $gt: 0 },
      expiresAt: { $gt: now },
    })
    .select("remaining")
    .lean();
  return lots.reduce((sum, l) => sum + Number(l.remaining || 0), 0);
}

/** Issue a 12-month credit lot. */
export function issueCredit(
  model: any,
  input: {
    ownerId: string;
    ownerRole?: string;
    amount: number;
    transactionId?: string;
    campaignId?: string;
    reason: string;
    createdBy?: string;
    now?: Date;
  },
) {
  const now = input.now || new Date();
  const amount = Math.round(Number(input.amount || 0));
  if (amount <= 0) return Promise.resolve(null);
  return model.create({
    ownerId: String(input.ownerId),
    ownerRole: input.ownerRole,
    type: "issued",
    amount,
    remaining: amount,
    expiresAt: creditExpiry(now),
    transactionId: input.transactionId,
    campaignId: input.campaignId,
    reason: input.reason,
    createdBy: input.createdBy || "system",
  });
}

/**
 * Spend up to `wanted` paise of credit for one transaction (earliest expiry first).
 * Returns the amount actually used.
 */
export async function consumeCredit(
  model: any,
  input: {
    ownerId: string;
    wanted: number;
    transactionId: string;
    campaignId?: string;
    now?: Date;
  },
): Promise<number> {
  const now = input.now || new Date();
  let left = Math.max(0, Math.round(Number(input.wanted || 0)));
  let used = 0;
  if (!left) return 0;
  const lots: any[] = await model
    .find({
      ownerId: String(input.ownerId),
      type: "issued",
      remaining: { $gt: 0 },
      expiresAt: { $gt: now },
    })
    .sort({ expiresAt: 1 })
    .lean();
  for (const lot of lots) {
    if (!left) break;
    const take = Math.min(left, Number(lot.remaining || 0));
    if (take <= 0) continue;
    const updated = await model
      .findOneAndUpdate(
        { _id: lot._id, remaining: { $gte: take }, expiresAt: { $gt: now } },
        { $inc: { remaining: -take } },
        { new: true },
      )
      .lean();
    if (!updated) continue; // spent meanwhile — try the next lot
    await model.create({
      ownerId: String(input.ownerId),
      type: "used",
      amount: take,
      lotId: lot._id,
      transactionId: String(input.transactionId),
      campaignId: input.campaignId,
      reason: "Applied to platform fee",
    });
    left -= take;
    used += take;
  }
  return used;
}

/** Give back credit used by a transaction whose payment was rejected. Idempotent. */
export async function restoreCreditUse(
  model: any,
  transactionId: string,
  createdBy = "system",
): Promise<number> {
  const uses: any[] = await model
    .find({
      transactionId: String(transactionId),
      type: "used",
      restoredAt: null,
    })
    .lean();
  let restored = 0;
  for (const use of uses) {
    const claimed = await model
      .findOneAndUpdate(
        { _id: use._id, restoredAt: null },
        { $set: { restoredAt: new Date() } },
        { new: true },
      )
      .lean();
    if (!claimed) continue;
    await model.updateOne(
      { _id: use.lotId },
      { $inc: { remaining: use.amount } },
    );
    await model.create({
      ownerId: use.ownerId,
      type: "restored",
      amount: use.amount,
      lotId: use.lotId,
      transactionId: String(transactionId),
      reason: "Payment rejected — credit returned",
      createdBy,
    });
    restored += use.amount;
  }
  return restored;
}

/**
 * Take back the credit issued for a transaction (settlement: post verified after the
 * refund). Removes what is still unused; returns how much had already been spent.
 */
export async function reverseIssuedCredit(
  model: any,
  transactionId: string,
  createdBy: string,
  reason: string,
): Promise<{ reversed: number; alreadyUsed: number }> {
  const lots: any[] = await model
    .find({ transactionId: String(transactionId), type: "issued" })
    .lean();
  let reversed = 0;
  let alreadyUsed = 0;
  for (const lot of lots) {
    const fresh: any = await model
      .findOneAndUpdate(
        { _id: lot._id, remaining: { $gt: 0 } },
        { $set: { remaining: 0 } },
        { new: false },
      )
      .lean();
    const unused = Number(fresh?.remaining || 0);
    alreadyUsed += Number(lot.amount || 0) - unused;
    if (unused > 0) {
      await model.create({
        ownerId: lot.ownerId,
        type: "reversed",
        amount: unused,
        lotId: lot._id,
        transactionId: String(transactionId),
        reason,
        createdBy,
      });
      reversed += unused;
    }
  }
  return { reversed, alreadyUsed };
}

/** Daily: remove unused credit from lots past their 12-month expiry. */
export async function expireCredit(model: any, now = new Date()) {
  const lots: any[] = await model
    .find({ type: "issued", remaining: { $gt: 0 }, expiresAt: { $lte: now } })
    .lean();
  let expired = 0;
  for (const lot of lots) {
    const fresh: any = await model
      .findOneAndUpdate(
        { _id: lot._id, remaining: { $gt: 0 }, expiresAt: { $lte: now } },
        { $set: { remaining: 0 } },
        { new: false },
      )
      .lean();
    const amount = Number(fresh?.remaining || 0);
    if (amount <= 0) continue;
    await model.create({
      ownerId: lot.ownerId,
      type: "expired",
      amount,
      lotId: lot._id,
      transactionId: lot.transactionId,
      reason: "Credit expired (12 months)",
    });
    expired += amount;
  }
  return { expired, lots: lots.length };
}

/** An owner's ledger, newest first, plus the current balance. */
export async function creditStatement(
  model: any,
  ownerId: string,
  now = new Date(),
) {
  const [entries, balance] = await Promise.all([
    model
      .find({ ownerId: String(ownerId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    creditBalance(model, ownerId, now),
  ]);
  const nextExpiry = (entries as any[])
    .filter(
      (e) =>
        e.type === "issued" &&
        Number(e.remaining) > 0 &&
        new Date(e.expiresAt).getTime() > now.getTime(),
    )
    .map((e) => new Date(e.expiresAt).getTime())
    .sort((a, b) => a - b)[0];
  return {
    balance,
    nextExpiry: nextExpiry ? new Date(nextExpiry) : null,
    entries,
  };
}
