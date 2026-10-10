import { Types } from "mongoose";

/**
 * Refunds to the payer of a paid collaboration (manual UPI). Four money states are kept
 * apart on the CampaignTransaction row, and every change is appended to refundHistory:
 *
 *   on_hold   the creator was closed without a post; nothing is owed yet. For 7 days
 *             the creator may submit a late post link for admin review.
 *   owed      the hold ended (no open report, no late post waiting) or an admin approved
 *             the refund. Admin still has to send it.
 *   sent      admin transferred it and recorded the UTR + date. Only this is "refunded".
 *   cancelled a late post was verified before any money went back; the creator is paid.
 *
 * If a post is verified AFTER the refund was sent, the refund is never reversed silently:
 * a settlement case opens (host repays → creator paid, or an admin-recorded exception).
 *
 * Pay-to-join campaigns keep their existing workflow and are never touched here.
 */
export const REFUND_HOLD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RefundStatus = "none" | "on_hold" | "owed" | "sent" | "cancelled";
export type SettlementStatus =
  | "none"
  | "awaiting_host_repayment"
  | "repaid"
  | "exception_approved";

/** Rows whose refund may be marked sent (atomic guard for markRefundSent). */
export const REFUND_DUE_FILTER = {
  refundStatus: "owed",
  "latePost.status": { $ne: "pending" },
} as const;

/** A settlement that still waits for the host's repayment. */
export const SETTLEMENT_OPEN = "awaiting_host_repayment";

/** Rows that can start a refund: paid collab, host's payment verified, not paid out. */
const REFUNDABLE_FILTER = {
  transactionType: "paid_collab",
  collectionStatus: "verified",
  payoutStatus: { $ne: "paid" },
} as const;

/** String form of an id that may be an ObjectId, a string or missing. */
export function idString(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : (v as { toString(): string }).toString();
}

/** Matches an id stored as ObjectId or string (older rows used plain strings). */
export function anyId(id: unknown): { $in: unknown[] } {
  const s = idString(id);
  const values: unknown[] = [s];
  if (Types.ObjectId.isValid(s) && s.length === 24) {
    values.push(new Types.ObjectId(s));
  }
  if (id && typeof id === "object") values.push(id);
  return { $in: values };
}

export function isRefundDue(tx: any): boolean {
  return tx?.refundStatus === "owed";
}

/** Full amount the payer paid (agreed amount + platform fee), in paise. */
export function refundDueAmount(tx: any): number {
  const n = Number(tx?.payerTotal || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function formatRupees(paise: number): string {
  const rupees = Number(paise || 0) / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: rupees % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Old rows marked "refund to brand" before refund statuses existed. Their real payment
 * history is unknown, so they are shown apart and never counted as owed or sent.
 */
export function isLegacyUnconfirmedRefund(tx: any): boolean {
  const status = tx?.refundStatus;
  return (
    tx?.transactionType === "paid_collab" &&
    tx?.collectionStatus === "verified" &&
    tx?.payoutStatus !== "paid" &&
    (!status || status === "none") &&
    (tx?.resolveOutcome === "refund_to_brand" || tx?.payoutStatus === "skipped")
  );
}

/** One display state per row for the admin Refunds tab and the host's history. */
export function refundState(
  tx: any,
):
  | "on_hold"
  | "owed"
  | "sent"
  | "settlement"
  | "legacy_unconfirmed"
  | "cancelled"
  | "none" {
  if (tx?.settlement?.status === SETTLEMENT_OPEN) return "settlement";
  const s = tx?.refundStatus;
  if (s === "on_hold" || s === "owed" || s === "sent" || s === "cancelled") {
    return s;
  }
  return isLegacyUnconfirmedRefund(tx) ? "legacy_unconfirmed" : "none";
}

export type RefundActor = {
  by?: unknown;
  byRole: "admin" | "system" | "host" | "creator";
};

export function historyEntry(
  action: string,
  actor: RefundActor,
  extra: Record<string, unknown> = {},
  at = new Date(),
) {
  return {
    at,
    action,
    by: actor.by != null ? idString(actor.by) : null,
    byRole: actor.byRole,
    ...extra,
  };
}

/**
 * The creator was closed without a post (deadline / campaign end / creator gave up a
 * dispute): put the payer's money on a 7-day hold. Only rows that have no refund yet.
 */
export async function holdRefunds(
  model: any,
  inviteId: unknown,
  now: Date,
  actor: RefundActor,
  reason: string,
): Promise<any[]> {
  const holdUntil = new Date(now.getTime() + REFUND_HOLD_DAYS * DAY_MS);
  const filter = {
    inviteId: anyId(inviteId),
    ...REFUNDABLE_FILTER,
    refundStatus: { $in: [null, "none", "cancelled"] },
  };
  const rows: any[] = await model.find(filter).select("_id").lean();
  if (!rows.length) return [];
  await model.updateMany(
    { _id: { $in: rows.map((r) => r._id) }, ...filter },
    {
      $set: {
        refundStatus: "on_hold",
        refundOnHoldAt: now,
        refundHoldUntil: holdUntil,
      },
      $push: {
        refundHistory: historyEntry(
          "refund_on_hold",
          actor,
          { to: "on_hold", holdUntil, note: reason },
          now,
        ),
      },
    },
  );
  return model.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
}

/**
 * A person approved the refund (admin dispute decision / admin cancellation): straight
 * to owed, skipping the hold. Records who decided and why.
 */
export async function markRefundsOwed(
  model: any,
  inviteId: unknown,
  now: Date,
  actor: RefundActor = { byRole: "admin" },
  reason = "",
): Promise<any[]> {
  const filter = {
    inviteId: anyId(inviteId),
    ...REFUNDABLE_FILTER,
    refundStatus: { $in: [null, "none", "cancelled", "on_hold"] },
  };
  const rows: any[] = await model.find(filter).select("_id").lean();
  if (!rows.length) return [];
  await model.updateMany(
    { _id: { $in: rows.map((r) => r._id) }, ...filter },
    {
      $set: {
        refundStatus: "owed",
        refundOwedAt: now,
        refundOwedBy: actor.by != null ? idString(actor.by) : null,
        refundOwedReason: reason,
      },
      $push: {
        refundHistory: historyEntry(
          "refund_owed",
          actor,
          { to: "owed", note: reason },
          now,
        ),
      },
    },
  );
  return model.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
}

export type ReleaseResult = {
  /** Rows now heading to the creator's payout (refund cancelled if it was pending). */
  released: any[];
  /** Rows whose refund was already sent: a settlement case was opened instead. */
  settlement: any[];
};

/**
 * Delivery verified (late post / post found / dispute decided for the creator): pay the
 * creator — but never if the host was already refunded. Each row moves with a guarded
 * update on its current refund status, so a concurrent "mark refund sent" can't also win;
 * a row that was refunded meanwhile becomes a settlement case.
 */
export async function releaseToCreator(
  model: any,
  inviteId: unknown,
  now: Date,
  actor: RefundActor,
  note: string,
): Promise<ReleaseResult> {
  const result: ReleaseResult = { released: [], settlement: [] };
  const rows: any[] = await model
    .find({ inviteId: anyId(inviteId), payoutStatus: { $ne: "paid" } })
    .lean();
  for (const row of rows) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current: any =
        attempt === 0 ? row : await model.findById(row._id).lean();
      if (!current || current.payoutStatus === "paid") break;
      if (current.transactionType === "pay_to_join") break;
      const status = current.refundStatus || "none";
      if (current.settlement?.status === SETTLEMENT_OPEN) break;

      if (status === "sent") {
        const amount = Number(current.refundAmount ?? current.payerTotal ?? 0);
        const updated = await model
          .findOneAndUpdate(
            {
              _id: current._id,
              refundStatus: "sent",
              "settlement.status": { $nin: [SETTLEMENT_OPEN] },
            },
            {
              $set: {
                workStatus: "approved",
                settlement: {
                  status: SETTLEMENT_OPEN,
                  amount,
                  openedAt: now,
                  openedBy: actor.by != null ? idString(actor.by) : null,
                  reason: note,
                },
                ...(current.latePost?.status === "pending"
                  ? { "latePost.status": "approved" }
                  : {}),
              },
              $push: {
                refundHistory: historyEntry(
                  "settlement_opened",
                  actor,
                  { amount, note },
                  now,
                ),
              },
            },
            { new: true },
          )
          .lean();
        if (updated) {
          result.settlement.push(updated);
          break;
        }
        continue;
      }

      const wasRefunding = status === "on_hold" || status === "owed";
      const set: Record<string, unknown> = {
        workStatus: "approved",
        payoutStatus:
          current.collectionStatus === "verified" ? "processing" : "pending",
        disputeStatus:
          current.disputeStatus === "open" ? "resolved" : current.disputeStatus,
        resolveOutcome: "release_to_influencer",
        resolvedAt: now,
      };
      if (wasRefunding) {
        set.refundStatus = "cancelled";
        set.refundCancelledAt = now;
      }
      if (current.latePost?.status === "pending") {
        set["latePost.status"] = "approved";
      }
      const guard: Record<string, unknown> = {
        _id: current._id,
        payoutStatus: { $ne: "paid" },
        refundStatus:
          status === "none" ? { $in: [null, "none"] } : current.refundStatus,
      };
      const update: Record<string, unknown> = { $set: set };
      if (wasRefunding) {
        update.$push = {
          refundHistory: historyEntry(
            "refund_cancelled_delivery_verified",
            actor,
            { from: status, to: "cancelled", note },
            now,
          ),
        };
      }
      const updated = await model
        .findOneAndUpdate(guard, update, { new: true })
        .lean();
      if (updated) {
        result.released.push(updated);
        break;
      }
      // Status changed under us (e.g. refund just marked sent) — re-read and retry once.
    }
  }
  return result;
}

/** What a creator sees about their late-post window on a closed collaboration. */
export type LatePostWindow = {
  canSubmit: boolean;
  until: Date | null;
  status: "pending" | "approved" | "rejected" | null;
  url: string | null;
  reviewNote: string | null;
};

export function latePostWindowView(row: any, now = Date.now()): LatePostWindow {
  const open =
    row?.refundStatus === "on_hold" &&
    !!row?.refundHoldUntil &&
    new Date(row.refundHoldUntil).getTime() > now;
  const status = row?.latePost?.status || null;
  return {
    canSubmit: open && !["pending", "approved"].includes(String(status)),
    until: row?.refundHoldUntil || null,
    status,
    url: row?.latePost?.url || null,
    reviewNote:
      status === "rejected" ? row?.latePost?.reviewNote || null : null,
  };
}

/** Late-post windows for a creator's closed invites, keyed by invite id. */
export async function latePostWindowsByInvite(
  model: any,
  inviteIds: unknown[],
): Promise<Map<string, LatePostWindow>> {
  const ids = inviteIds.flatMap((id) => [id, idString(id)]);
  if (!ids.length) return new Map();
  const rows: any[] = await model
    .find({
      inviteId: { $in: ids },
      $or: [
        { refundStatus: "on_hold" },
        { "latePost.status": { $in: ["pending", "rejected"] } },
      ],
    })
    .select("inviteId refundStatus refundHoldUntil latePost")
    .lean();
  return new Map(
    rows.map((r) => [idString(r.inviteId), latePostWindowView(r)]),
  );
}

/** Notice to the payer (host) — push + in-app. Non-blocking. */
export function notifyPayer(
  deps: { pushService: any; notificationsService: any },
  tx: any,
  title: string,
  body: string,
) {
  const userId = String(tx?.payerId || "");
  if (!userId) return;
  const role = String(tx?.payerRole || "brand") as
    | "brand"
    | "influencer"
    | "photographer";
  deps.pushService
    ?.sendToUser(userId, { title, body, url: "/transactions" }, "payment")
    ?.catch?.(() => {
      /* non-critical */
    });
  deps.notificationsService
    ?.createForUser({
      userId,
      userRole: role,
      title,
      body,
      url: "/transactions",
    })
    ?.catch?.(() => {
      /* non-critical */
    });
}

/** Closure notice: the refund is under review, not promised. */
export function refundOnHoldNotice(tx: any, campaignTitle: string) {
  const until = tx?.refundHoldUntil ? new Date(tx.refundHoldUntil) : null;
  const date = until
    ? until.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : "the review period";
  return {
    title: "Refund under review",
    body: `A creator in "${campaignTitle}" did not submit a post. ${formatRupees(
      refundDueAmount(tx),
    )} will be reviewed for refund after ${date}. This is not yet approved — TrendStarZ will confirm when it is sent.`,
  };
}

/**
 * Risk flags for the admin Refunds queue — a pattern, not proof. Computed from refund
 * rows of the last 90 days (any refund state except cancelled/none).
 */
export const RISK_WINDOW_DAYS = 90;

export function riskFlags(
  tx: any,
  recent: Array<{
    _id: unknown;
    payerId: unknown;
    recipientId: unknown;
    createdAt?: Date;
  }>,
): string[] {
  const id = String(tx?._id);
  const payer = String(tx?.payerId);
  const recipient = String(tx?.recipientId);
  const others = recent.filter((r) => String(r._id) !== id);
  const flags: string[] = [];
  if (
    others.some(
      (r) => String(r.payerId) === payer && String(r.recipientId) === recipient,
    )
  ) {
    flags.push("repeat_pair");
  }
  if (recent.filter((r) => String(r.payerId) === payer).length >= 2) {
    flags.push("host_repeat_refunds");
  }
  if (recent.filter((r) => String(r.recipientId) === recipient).length >= 2) {
    flags.push("creator_repeat_no_post");
  }
  return flags;
}
