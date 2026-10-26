/**
 * Dates shown to people (emails, WhatsApp, push, messages) are always India time.
 * The server runs on UTC, so formatting without a time zone can show the previous
 * day for anything stored as an IST day boundary (e.g. 18:30 UTC = midnight IST).
 */
export function formatIstDate(
  value: unknown,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  const date = value instanceof Date ? value : value ? new Date(value as any) : null;
  if (!date || isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { ...options, timeZone: "Asia/Kolkata" });
}
