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
