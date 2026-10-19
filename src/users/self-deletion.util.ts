import { idIn } from "../utils/id-match.util";
import { SETTLEMENT_OPEN } from "../payments-payouts/campaign-refund.util";

/** Invites with work under way: neither side may self-delete while one is open. */
export const SELF_DELETION_BLOCKING_INVITE_STATUSES = [
  "counter_sent",
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "disputed",
];

/** Invites where this user (creator or host) has work under way. */
export function openWorkFilter(userId: string) {
  const me = idIn(userId);
  return {
    $or: [{ influencerId: me }, { brandId: me }],
    status: { $in: SELF_DELETION_BLOCKING_INVITE_STATUSES },
  };
}

/** Payment rows where money to or from this user isn't settled yet. */
export function openMoneyFilter(userId: string) {
  const me = idIn(userId);
  return {
    $and: [
      { $or: [{ payerId: me }, { recipientId: me }] },
      {
        $or: [
          {
            collectionStatus: { $in: ["proof_submitted", "verified"] },
            payoutStatus: { $in: ["pending", "processing"] },
            refundStatus: { $ne: "sent" },
          },
          { refundStatus: { $in: ["owed", "on_hold"] } },
          { "settlement.status": SETTLEMENT_OPEN },
        ],
      },
    ],
  };
}
