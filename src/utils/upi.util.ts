/**
 * UPI ID (VPA) format: handle@bank, e.g. name.surname@okhdfcbank or 9876543210@ybl.
 * A format check only — it can't tell whether the ID exists or whose it is.
 */
const UPI_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63}$/;

/** Trimmed, lowercased (UPI IDs aren't case-sensitive). */
export function normalizeUpiId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Why this UPI ID can't be right, or null. An empty value is allowed (not given). */
export function upiIdError(value: unknown): string | null {
  const upi = normalizeUpiId(value);
  if (!upi) return null;
  if (!UPI_ID_PATTERN.test(upi)) {
    return "That UPI ID doesn't look right. It should look like name@bank (for example 9876543210@ybl).";
  }
  return null;
}

/**
 * Payout details from a form (signup): trimmed, UPI ID lowercased; throws the reason
 * via `fail` when the UPI ID is mistyped.
 */
export function payoutFromInput(
  input: any,
  fail: (message: string) => never,
): { upiId: string; mobile: string; accountHolderName: string } {
  const error = upiIdError(input?.upiId);
  if (error) fail(error);
  return {
    upiId: normalizeUpiId(input?.upiId),
    mobile: String(input?.mobile ?? "").trim(),
    accountHolderName: String(input?.accountHolderName ?? "").trim(),
  };
}

/**
 * The extra fields to save when a creator's payout UPI ID changes (nothing when
 * it's the same or only newly added): when, and what it was before.
 */
export function upiChangeFields(previous: unknown, next: unknown, now = new Date()): Record<string, any> {
  const before = normalizeUpiId(previous);
  const after = normalizeUpiId(next);
  if (!before || before === after) return {};
  return { "payout.upiChangedAt": now, "payout.previousUpiId": before };
}

/** "ab***@okaxis" — enough for the owner to recognise, not enough to reuse. */
export function maskUpiId(value: unknown): string {
  const upi = normalizeUpiId(value);
  const [name, bank] = upi.split("@");
  if (!name || !bank) return upi ? "***" : "";
  return `${name.slice(0, 2)}***@${bank}`;
}
