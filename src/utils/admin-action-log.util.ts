import type { Collection } from "mongodb";

/**
 * Append-only record of admin actions on accounts that keep no history of their
 * own (accept/decline, delete/restore/permanent delete, Premium, contact
 * verification, temporary password, community status, image edits): who did
 * what to which account, when. Money actions record their admin on the payment
 * itself; verification and tags keep their own audit logs.
 */
export const ADMIN_ACTIONS = "admin_actions";

let log: Collection<any> | null = null;

/** Connected at startup (DataIntegrityService.onModuleInit). */
export function setAdminActionCollection(collection: Collection<any> | null) {
  log = collection;
}

const SECRET_KEYS = /password|token|secret|otp|code/i;

/** Best effort: never fails the admin action it records. Secrets are never stored. */
export async function recordAdminAction(
  req: any,
  action: string,
  target: { type: string; id: string },
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!log) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details || {})) {
    if (!SECRET_KEYS.test(k) && v !== undefined) safe[k] = v;
  }
  await log
    .insertOne({
      at: new Date(),
      adminId: String(req?.user?.userId || req?.user?.id || ""),
      adminRole: String(req?.user?.role || ""),
      action,
      targetType: String(target.type || ""),
      targetId: String(target.id || ""),
      details: safe,
    })
    .catch(() => undefined);
}

/** Short, safe summary of a request body: primitives kept, lists/objects as counts. */
export function summarizeBody(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body && typeof body === "object" ? body : {})) {
    if (SECRET_KEYS.test(k) || v === undefined) continue;
    if (v === null || typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else out[k] = "[object]";
  }
  return out;
}
