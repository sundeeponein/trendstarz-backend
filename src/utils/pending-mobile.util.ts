import { canonicalPhone } from "./phone.util";

/**
 * Mobile number changes (2026-11-10).
 *
 * A VERIFIED number is never dropped on a profile save: the new number waits as
 * pendingPhoneNumber until an admin verifies it, and the old verified number
 * stays in use (search, invites, what hosts see). So a creator who changes their
 * number keeps receiving and accepting invites, and an unverified number never
 * reaches a host.
 *
 * An UNVERIFIED number is simply replaced (nothing verified to keep).
 */
export const PENDING_MOBILE_FIELDS = ["pendingPhoneNumber", "pendingPhoneRequestedAt"] as const;

export interface MobileChangePlan {
  /** Fields to $set on the profile (may be empty). */
  set: Record<string, unknown>;
  /** false = leave phoneNumber as stored (drop it from the update). */
  applyPhone: boolean;
  /** A new pending request was created. */
  pendingCreated: boolean;
}

export function planMobileChange(
  current: { phoneNumber?: unknown; isMobileVerified?: unknown; pendingPhoneNumber?: unknown },
  incomingRaw: unknown,
  now: Date = new Date(),
): MobileChangePlan {
  const existing = canonicalPhone(current?.phoneNumber);
  const incoming = canonicalPhone(incomingRaw);
  const pending = canonicalPhone(current?.pendingPhoneNumber);
  // Same number (or the profile form re-sending it): nothing changes. A waiting
  // request is only withdrawn on purpose (cancel), never by an ordinary save.
  if (!incoming || incoming === existing) {
    return { set: {}, applyPhone: false, pendingCreated: false };
  }
  if (current?.isMobileVerified === true) {
    if (incoming === pending) return { set: {}, applyPhone: false, pendingCreated: false };
    return {
      set: { pendingPhoneNumber: incoming, pendingPhoneRequestedAt: now },
      applyPhone: false,
      pendingCreated: true,
    };
  }
  // Not verified yet: replace it; any older pending request is moot.
  return {
    set: { isMobileVerified: false, pendingPhoneNumber: "", pendingPhoneRequestedAt: null },
    applyPhone: true,
    pendingCreated: false,
  };
}

/** Invite statuses after which the stored shipping contact is a record, not a live contact. */
export const FINISHED_INVITE_STATUSES = [
  "completed",
  "cancelled",
  "declined",
  "expired",
  "rejected",
  "withdrawn",
];
