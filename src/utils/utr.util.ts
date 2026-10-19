/**
 * UPI/bank reference (UTR) as typed by a payer: spaces and dashes removed, upper-case,
 * so "4321 8765 1234" and "432187651234" are recognised as the same payment.
 */
export function normalizeUtr(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

/** Stored forms to look for: the normalized UTR and the raw trimmed text (older rows). */
export function utrMatchValues(value: unknown): string[] {
  const raw = String(value ?? "").trim();
  return [...new Set([normalizeUtr(value), raw].filter(Boolean))];
}
