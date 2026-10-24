/**
 * Links people type (brand website, promotion link, map link, post link).
 * Stored as a full http(s) address: "brand.in" becomes "https://brand.in"
 * (without the scheme a browser treats it as a page inside TrendStarZ), and
 * anything that isn't a web address (javascript:, data:, …) is not stored.
 */
export function normalizeExternalUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return isValidHttpUrl(text) ? text : "";
  // Any other scheme (javascript:, data:, mailto:, …) — but not "host:port".
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+\.[a-z]{2,}:\d/i.test(text)) return "";
  if (/^\/\//.test(text)) return isValidHttpUrl(`https:${text}`) ? `https:${text}` : "";
  const withScheme = `https://${text}`;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([:/?#]|$)/i.test(text) && isValidHttpUrl(withScheme)
    ? withScheme
    : "";
}

function isValidHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

/** Mongoose setter form: keeps null/undefined as they are. */
export function externalUrlSetter(value: unknown) {
  if (value === null || value === undefined) return value;
  return normalizeExternalUrl(value);
}
