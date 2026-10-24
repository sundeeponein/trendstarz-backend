/**
 * One stored form for Indian mobile numbers: the 10 digits. "+91 98765 43210",
 * "098765-43210" and "9876543210" are the same number — stored (and compared)
 * as typed they looked different, so the one-number-per-account check missed
 * them. Anything that isn't an Indian mobile keeps its digits only.
 */
export function canonicalPhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Mongoose setter form: keeps null/undefined/"" as they are. */
export function phoneSetter(value: unknown) {
  if (value === null || value === undefined || value === "") return value;
  // Text with no digits at all (the "deleted" placeholder of an anonymized
  // account) is not a number — keep it as it is.
  return canonicalPhone(value) || String(value).trim();
}
