/**
 * A creator's monthly invite slots — one rule for Search, the invite lists and
 * the send check, so a creator never shows as available and then gets refused.
 *
 * An invite holds one of the creator's slots for their plan month when it is:
 *  - accepted or further along (accepted … completed), or
 *  - still pending and not past its due date, or
 *  - a no-show: accepted, then closed because nothing was submitted — unless an
 *    admin excused it (missExcused). Host/admin cancellations and refunds free it.
 * Declined and other withdrawn invites free the slot.
 *
 * Counted by creator id only: CampaignInvite has no stored recipientRole, and
 * influencer/photographer ids never collide.
 */

import { Types } from "mongoose";

const SLOT_HOLDING_STATUSES = [
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "approved",
  "completed",
];

/** Set on closures by expireUnsubmittedInvite (see INVITE_WITHDRAWN_REASONS). */
export const NO_SHOW_REASON_CODE = "expired_unsubmitted";

/** Closure texts written before withdrawnReasonCode existed — the no-show ones only. */
const LEGACY_NO_SHOW_REASONS = [
  "Posting deadline and grace period expired with no submission.",
  "Campaign's grace period ended with no submission.",
  "Campaign ended by host before submission.",
];

/** Mongo match for invites that hold a creator's monthly slot right now. */
export function slotHoldingInviteMatch(now: Date = new Date()) {
  return {
    $or: [
      { status: { $in: SLOT_HOLDING_STATUSES } },
      {
        $and: [
          { status: { $in: ["pending", "invited"] } },
          { overdueFlaggedAt: null },
          {
            $or: [
              { dueDate: null },
              { dueDate: { $gte: now } },
            ],
          },
        ],
      },
      {
        $and: [
          { status: "withdrawn" },
          { "missExcused.at": null },
          {
            $or: [
              { withdrawnReasonCode: NO_SHOW_REASON_CODE },
              {
                withdrawnReasonCode: null,
                withdrawnReason: { $in: LEGACY_NO_SHOW_REASONS },
              },
            ],
          },
        ],
      },
    ],
  };
}

function isCurrentlyPremium(user: any, now: Date): boolean {
  if (!user?.isPremium) return false;
  if (!user.premiumEnd) return true;
  return new Date(user.premiumEnd) >= now;
}

/**
 * Start of the creator's current plan month: anchored on premiumStart while
 * premium is active, else on signup (createdAt).
 */
export function planCycleStart(user: any, now: Date = new Date()): Date {
  const anchorRaw =
    isCurrentlyPremium(user, now) && user?.premiumStart
      ? user.premiumStart
      : user?.createdAt;
  const anchor = anchorRaw ? new Date(anchorRaw) : new Date(0);
  if (anchor > now) return anchor;
  const cycle = new Date(anchor);
  while (true) {
    const next = new Date(cycle);
    next.setMonth(next.getMonth() + 1);
    if (next > now) break;
    cycle.setTime(next.getTime());
  }
  return cycle;
}

/** Slots one creator has used this plan month. */
export async function countUsedMonthlySlots(
  inviteModel: any,
  creatorId: string,
  creator: any,
  now: Date = new Date(),
): Promise<number> {
  return inviteModel.countDocuments({
    influencerId: creatorId,
    createdAt: { $gte: planCycleStart(creator, now) },
    ...slotHoldingInviteMatch(now),
  });
}

function asObjectId(id: unknown): Types.ObjectId | null {
  const s = String(id ?? "");
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

/**
 * Ids (as strings) of the given creators whose monthly slots are all used.
 * `capFor` returns the creator's monthly cap; -1 = unlimited. One query for
 * the whole list.
 */
export async function fullyBookedCreatorIds(
  inviteModel: any,
  creators: any[],
  capFor: (creator: any) => number,
  now: Date = new Date(),
): Promise<Set<string>> {
  const capped = (creators || []).filter((c) => {
    const cap = capFor(c);
    return c?._id && Number.isFinite(cap) && cap !== -1;
  });
  const full = new Set<string>();
  if (!capped.length) return full;

  const cycleById = new Map<string, Date>();
  for (const c of capped) cycleById.set(String(c._id), planCycleStart(c, now));
  const earliest = new Date(
    Math.min(...[...cycleById.values()].map((d) => d.getTime())),
  );
  const ids = capped
    .map((c) => asObjectId(c._id))
    .filter((id): id is Types.ObjectId => !!id);

  const rows: Array<{ _id: unknown; dates: Date[] }> = await inviteModel
    .aggregate([
      {
        $match: {
          influencerId: { $in: ids },
          createdAt: { $gte: earliest },
          ...slotHoldingInviteMatch(now),
        },
      },
      { $group: { _id: "$influencerId", dates: { $push: "$createdAt" } } },
    ])
    .exec();

  const datesById = new Map<string, Date[]>();
  for (const r of rows || []) datesById.set(String(r._id), r.dates || []);

  for (const c of capped) {
    const id = String(c._id);
    const since = cycleById.get(id)!.getTime();
    const used = (datesById.get(id) || []).filter(
      (d) => new Date(d).getTime() >= since,
    ).length;
    if (used >= capFor(c)) full.add(id);
  }
  return full;
}
