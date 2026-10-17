import { Types } from "mongoose";

/**
 * Matches a reference stored either as an ObjectId or as its string — older
 * rows saved some references (campaignId, inviteId, …) as plain strings.
 * Use as a query value: `{ inviteId: idIn(invite._id) }`.
 */
export function idIn<T>(id: T): { $in: [T, string] } {
  return { $in: [id, String(id)] };
}

/**
 * Many-id version of idIn: matches each id as an ObjectId (when valid) or as
 * its string. Needed in aggregate() $match stages, which — unlike find() — do
 * no schema casting, so a list of string ids never matches ObjectId fields.
 */
export function idsIn(ids: Array<string | Types.ObjectId>): {
  $in: Array<string | Types.ObjectId>;
} {
  const out: Array<string | Types.ObjectId> = [];
  for (const id of ids || []) {
    const s = String(id || "").trim();
    if (!s) continue;
    out.push(s);
    if (Types.ObjectId.isValid(s) && /^[a-f0-9]{24}$/i.test(s)) {
      out.push(new Types.ObjectId(s));
    }
  }
  return { $in: out };
}
