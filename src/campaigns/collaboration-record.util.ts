/**
 * Collaboration record (pure): what happened to a person's invites, counted the
 * same way for the creator side (invites received) and the host side (invites
 * sent). Shown to the owner on their profile and to admins — never public.
 */
import { isNoShowClosure } from "./creator-monthly-slots.util";

export interface CollaborationSide {
  total: number;
  accepted: number;
  completedOnTime: number;
  completedLate: number;
  didNotPost: number;
  /** Of didNotPost, how many an admin excused. */
  didNotPostExcused: number;
  inProgress: number;
  disputed: number;
  declined: number;
  /** Invite still open, not answered yet. */
  awaitingReply: number;
  /** Closed without an answer (expired unanswered, withdrawn before acceptance). */
  noResponse: number;
  /** Accepted ÷ answered (accepted + declined), %; null until anything is answered. */
  acceptanceRate: number | null;
  /** Completed ÷ finished-accepted (completed + didn't post + disputed), %; null until any finishes. */
  completionRate: number | null;
}

export interface CollaborationRecord {
  asCreator: CollaborationSide | null;
  asHost: (CollaborationSide & { campaigns: number }) | null;
}

const FINISHED = ["completed", "approved"];
/** Counter-offers count as in progress: both sides are still talking. */
const IN_PROGRESS = ["counter_sent", "accepted", "payment_confirmed", "working", "submitted"];
const AWAITING_ANSWER = ["pending", "invited"];

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** `lateInviteIds`: invites whose (latest) submission was late. */
export function summarizeInvites(invites: any[], lateInviteIds: Set<string>): CollaborationSide {
  const s: CollaborationSide = {
    total: invites.length,
    accepted: 0,
    completedOnTime: 0,
    completedLate: 0,
    didNotPost: 0,
    didNotPostExcused: 0,
    inProgress: 0,
    disputed: 0,
    declined: 0,
    awaitingReply: 0,
    noResponse: 0,
    acceptanceRate: null,
    completionRate: null,
  };
  for (const inv of invites) {
    const status = String(inv?.status || "");
    if (FINISHED.includes(status)) {
      if (lateInviteIds.has(String(inv._id))) s.completedLate++;
      else s.completedOnTime++;
    } else if (status === "disputed") {
      s.disputed++;
    } else if (IN_PROGRESS.includes(status)) {
      s.inProgress++;
    } else if (status === "declined") {
      s.declined++;
    } else if (isNoShowClosure(inv)) {
      s.didNotPost++;
      if (inv?.missExcused?.at) s.didNotPostExcused++;
    } else if (AWAITING_ANSWER.includes(status)) {
      s.awaitingReply++;
    } else if (status === "withdrawn") {
      s.noResponse++;
    }
  }
  const completed = s.completedOnTime + s.completedLate;
  // counter_sent is in progress but not yet accepted.
  const acceptedInProgress = invites.filter((i) =>
    ["accepted", "payment_confirmed", "working", "submitted"].includes(String(i?.status || "")),
  ).length;
  s.accepted = completed + s.disputed + s.didNotPost + acceptedInProgress;
  s.acceptanceRate = pct(s.accepted, s.accepted + s.declined);
  s.completionRate = pct(completed, completed + s.didNotPost + s.disputed);
  return s;
}
