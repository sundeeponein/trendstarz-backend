/**
 * Admin follow-up (pure): for an invite that is waiting on someone, who it is
 * waiting on, why, since when, and whether that person has opened it / been
 * active since. Admin-only — never sent to hosts or creators.
 */

export type FollowUpSide = "creator" | "host";

export interface InviteFollowUp {
  waitingOn: FollowUpSide | null;
  /** e.g. "Reply to invite", "Pay to confirm". */
  reason: string;
  since: Date | null;
  creatorFirstSeenAt: Date | null;
  creatorLastSeenAt: Date | null;
  creatorLastActiveAt: Date | null;
  hostLastSeenAt: Date | null;
  hostLastActiveAt: Date | null;
  /** The person we're waiting on opened it after `since`. */
  seenSince: boolean;
  /** The person we're waiting on logged in / opened the app after `since`. */
  activeSince: boolean;
}

const latest = (...dates: any[]): Date | null => {
  const t = dates.map((d) => (d ? new Date(d).getTime() : NaN)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)) : null;
};

/** Who must act next, or null when nobody is being waited on. */
export function waitingStage(invite: any, campaignType?: string): { waitingOn: FollowUpSide | null; reason: string; since: Date | null } {
  const status = String(invite?.status || "");
  const counter = String(invite?.counterOffer?.status || "");
  const at = (d: any) => (d ? new Date(d) : null);
  if (status === "pending" || status === "invited") {
    return { waitingOn: "creator", reason: "Reply to invite", since: at(invite.createdAt) };
  }
  if (status === "counter_sent" && counter === "sent") {
    return { waitingOn: "host", reason: "Reply to creator's counter-offer", since: at(invite.counterOffer?.sentAt || invite.updatedAt) };
  }
  if (status === "counter_sent" && counter === "brand_sent") {
    return { waitingOn: "creator", reason: "Reply to host's counter-offer", since: at(invite.counterOffer?.sentAt || invite.updatedAt) };
  }
  if (status === "accepted") {
    const paid = String(campaignType || "").toLowerCase() === "paid_collab";
    return { waitingOn: "host", reason: paid ? "Pay to confirm the creator" : "Confirm the creator", since: at(invite.acceptedAt || invite.updatedAt) };
  }
  return { waitingOn: null, reason: "", since: null };
}

export function buildFollowUp(input: {
  invite: any;
  campaignType?: string;
  creatorView?: { firstAt?: Date; lastAt?: Date } | null;
  hostView?: { lastAt?: Date } | null;
  creator?: any;
  host?: any;
}): InviteFollowUp {
  const stage = waitingStage(input.invite, input.campaignType);
  const creatorLastActiveAt = latest(input.creator?.lastLoginAt, input.creator?.lastOpenedAt);
  const hostLastActiveAt = latest(input.host?.lastLoginAt, input.host?.lastOpenedAt);
  const creatorLastSeenAt = input.creatorView?.lastAt ? new Date(input.creatorView.lastAt) : null;
  const hostLastSeenAt = input.hostView?.lastAt ? new Date(input.hostView.lastAt) : null;

  const seen = stage.waitingOn === "host" ? hostLastSeenAt : stage.waitingOn === "creator" ? creatorLastSeenAt : null;
  const active = stage.waitingOn === "host" ? hostLastActiveAt : stage.waitingOn === "creator" ? creatorLastActiveAt : null;
  const after = (d: Date | null) => !!d && !!stage.since && d.getTime() >= stage.since.getTime();

  return {
    ...stage,
    creatorFirstSeenAt: input.creatorView?.firstAt ? new Date(input.creatorView.firstAt) : null,
    creatorLastSeenAt,
    creatorLastActiveAt,
    hostLastSeenAt,
    hostLastActiveAt,
    seenSince: after(seen),
    activeSince: after(active),
  };
}
