/**
 * True when a request is hitting the API from localhost in a non-production
 * environment. Used to skip real Firebase email/mobile verification during
 * local development so the app stays usable without sending real emails/SMS.
 */
export function isLocalAuthBypassRequest(req: any): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const host = String(req?.get?.("host") || req?.hostname || "").toLowerCase();
  return (
    host.startsWith("localhost:") ||
    host === "localhost" ||
    host.startsWith("127.0.0.1:") ||
    host === "127.0.0.1" ||
    host.startsWith("[::1]:") ||
    host === "::1"
  );
}
