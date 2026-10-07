/**
 * Campaign and submission deadlines (pure). One place for the timing rules so the
 * submit check, the per-invite expiry, the campaign auto-close and the admin
 * corrections all agree.
 *
 * - A campaign's end date is a calendar date: it ends at the END of that day in
 *   India time (end dates are stored as midnight UTC of the date, i.e. 05:30 IST).
 * - A creator's submission window runs from their chosen post date (+24h, plus
 *   24h grace unless the campaign is "strict"). It is never shorter than
 *   SUBMIT_HOURS_AFTER_PAYMENT after their payment was confirmed, and an admin
 *   can extend it further (submissionDeadlineExtendedTo).
 */

const HOUR_MS = 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** A creator always gets at least this long to submit after their payment is confirmed. */
export const SUBMIT_HOURS_AFTER_PAYMENT = 48;

/** Most an admin can extend one creator's submission deadline, from now. */
export const MAX_ADMIN_EXTENSION_DAYS = 7;

function toTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const t = new Date(value as any).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 23:59:59.999 IST on the India calendar day that contains `at`. */
export function endOfIstDay(at: Date): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const istMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(istMidnightAsUtc - IST_OFFSET_MS + 24 * HOUR_MS - 1);
}

/** When a campaign's end date is over: the end of the latest of endDate/timelineEnd (IST day). */
export function campaignEndsAt(campaign: {
  endDate?: unknown;
  timelineEnd?: unknown;
}): Date | null {
  const times = [
    toTime(campaign?.endDate),
    toTime(campaign?.timelineEnd),
  ].filter((t): t is number => t !== null);
  if (!times.length) return null;
  return endOfIstDay(new Date(Math.max(...times)));
}

export interface SubmissionWindow {
  /** Submitting after this is "late" (still allowed until closesAt). */
  strictDeadline: Date;
  /** Submitting is blocked after this. */
  closesAt: Date;
}

/**
 * The creator's submission window, or null when there is no deadline (no post
 * date chosen yet — unchanged from before).
 */
export function submissionWindow(
  invite: {
    selectedPostDate?: unknown;
    paymentConfirmedAt?: unknown;
    submissionDeadlineExtendedTo?: unknown;
  },
  postingDeadlineMode?: string,
): SubmissionWindow | null {
  const postDate = toTime(invite?.selectedPostDate);
  if (postDate === null) return null;

  const postStrict = postDate + 24 * HOUR_MS;
  const postCloses =
    postingDeadlineMode === "strict" ? postStrict : postStrict + 24 * HOUR_MS;

  const paidAt = toTime(invite?.paymentConfirmedAt);
  const paidCloses =
    paidAt === null ? null : paidAt + SUBMIT_HOURS_AFTER_PAYMENT * HOUR_MS;

  // Paid late (e.g. on the campaign's last day): the 48h from payment is on time, not late.
  const strictDeadline = Math.max(postStrict, paidCloses ?? postStrict);
  let closesAt = Math.max(postCloses, paidCloses ?? postCloses);

  const extendedTo = toTime(invite?.submissionDeadlineExtendedTo);
  if (extendedTo !== null) closesAt = Math.max(closesAt, extendedTo);

  return {
    strictDeadline: new Date(strictDeadline),
    closesAt: new Date(closesAt),
  };
}
