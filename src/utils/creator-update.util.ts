import { Model } from "mongoose";

/**
 * Admin "updated since review" tracking.
 *
 * Creator self-saves record WHICH profile sections actually changed, so admins
 * can filter for profiles that need a second look after approval. This is a
 * review signal only: it never changes approval status, visibility, badges,
 * tiers or verification. Admin edits never call this.
 *
 * Fields (select:false on the profile — never part of public/brand responses):
 *   creatorUpdatedAt          last time the creator saved a real change
 *   creatorUpdatedFields      sections changed since the last admin review
 *   creatorUpdatesReviewedAt  last time an admin cleared them
 */

/**
 * Keys that are bookkeeping, not profile content — including verification
 * state the SERVER sets during a save (e.g. resetting isMobileVerified after a
 * phone change; the phone change itself is still recorded as "phoneNumber").
 */
const IGNORED_KEYS = new Set([
  "_id",
  "createdAt",
  "updatedAt",
  "lastUpdatedAt",
  "verificationDisclaimerAccepted",
  "isEmailVerified",
  "isMobileVerified",
  "emailVerified",
  "mobileVerified",
  "emailVerifiedAt",
  "mobileVerifiedAt",
  "mobileVerificationDate",
  "mobileVerificationMethod",
  "mobileVerifiedBy",
  "previousVerifiedEmail",
  "previousVerifiedMobile",
]);

/** Order-insensitive for object keys, stable for arrays; treats null/undefined/"" as the same empty value. */
function canonical(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const v = value as { toHexString?: () => string; toObject?: () => unknown };
    if (typeof v.toHexString === "function") return v.toHexString();
    const source =
      typeof v.toObject === "function"
        ? (v.toObject() as Record<string, unknown>)
        : (value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      const c = canonical(source[key]);
      if (c !== null) out[key] = c;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

function getPath(doc: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[k]
          : undefined,
      doc,
    );
}

/**
 * Top-level sections whose value in `update` differs from `before`.
 * Dotted keys ("payout.upiId") report their root ("payout").
 */
export function changedProfileSections(
  before: Record<string, unknown> | null | undefined,
  update: Record<string, unknown> | null | undefined,
): string[] {
  const sections = new Set<string>();
  for (const [key, next] of Object.entries(update || {})) {
    const root = key.split(".")[0];
    if (IGNORED_KEYS.has(root)) continue;
    const prev = getPath(before || {}, key);
    if (JSON.stringify(canonical(prev)) !== JSON.stringify(canonical(next))) {
      sections.add(root);
    }
  }
  return [...sections].sort();
}

/** Projection for reading exactly the fields an update touches (before writing it). */
export function sectionsProjection(update: Record<string, unknown>): string {
  return Object.keys(update || {})
    .filter((k) => !k.startsWith("$"))
    .join(" ");
}

/** Records changed sections after a successful creator save. No-op when nothing changed. */
export async function recordCreatorUpdate(
  model: Pick<Model<any>, "updateOne">,
  profileId: string,
  sections: string[],
  now: Date = new Date(),
): Promise<void> {
  if (!sections.length) return;
  try {
    await model.updateOne(
      { _id: profileId },
      {
        $set: { creatorUpdatedAt: now },
        $addToSet: { creatorUpdatedFields: { $each: sections } },
      },
    );
  } catch (err) {
    // The creator's save already succeeded — a missed review hint must not fail it.
    console.error(
      "[creator-update] could not record updated sections:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
