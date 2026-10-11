/**
 * Paid-collaboration terms both sides accept (host when paying, creator when accepting).
 * DRAFT for review — the wording must be checked for enforceability in India before it
 * is treated as binding. Bump the version whenever the text changes; each acceptance
 * stores the version it was given.
 *
 * Version 2 adds the paid-slot rule and the fee-credit refund policy. Those two financial
 * rules only apply once an admin sets `paidCollabTermsV2EffectiveAt` in app settings (after
 * the legal review) and only to payments made from that moment — never retroactively.
 */
export const PAID_COLLAB_TERMS_VERSION_V1 = "2026-10-draft-1";
export const PAID_COLLAB_TERMS_VERSION_V2 = "2026-10-draft-2";
/** @deprecated kept for callers written before v2 — the v1 version string. */
export const PAID_COLLAB_TERMS_VERSION = PAID_COLLAB_TERMS_VERSION_V1;

export const PAID_COLLAB_TERMS_SUMMARY = [
  "Once the host's payment is confirmed, only TrendStarZ can cancel this collaboration.",
  "If the creator does not submit a post by the deadline, the host's payment is held for 7 days and reviewed before any refund.",
  "For 12 months from the date contact details were first shared through TrendStarZ, paid work between the same host and creator must be arranged through TrendStarZ.",
  "Asking the other side to skip posting, cancel, or deal outside TrendStarZ can be reported. If TrendStarZ confirms it, TrendStarZ may charge its fee and review or suspend the accounts involved.",
];

/** Added in version 2 (shown only once the v2 effective date is set and reached). */
export const PAID_COLLAB_TERMS_V2_ADDITIONS = [
  "A paid invite stays counted in the campaign's invite limit even if the collaboration closes or is refunded.",
  "If the creator does not post, the creator's agreed amount is refunded by UPI and the platform fee is returned as TrendStarZ credit, valid for 12 months and usable only for future TrendStarZ platform fees.",
];

export const OFFPLATFORM_REPORT_LABEL =
  "Asked to skip posting / deal outside TrendStarZ";

/** When the v2 financial rules start (null = not active yet). */
export function termsV2EffectiveAt(settings: any): Date | null {
  const raw = settings?.paidCollabTermsV2EffectiveAt;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** True once the v2 financial rules (paid-slot, fee credit) apply at `at`. */
export function termsV2Active(settings: any, at = new Date()): boolean {
  const from = termsV2EffectiveAt(settings);
  return !!from && at.getTime() >= from.getTime();
}

export function currentTermsVersion(settings: any, at = new Date()): string {
  return termsV2Active(settings, at)
    ? PAID_COLLAB_TERMS_VERSION_V2
    : PAID_COLLAB_TERMS_VERSION_V1;
}
