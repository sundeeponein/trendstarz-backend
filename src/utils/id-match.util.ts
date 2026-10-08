/**
 * Matches a reference stored either as an ObjectId or as its string — older
 * rows saved some references (campaignId, inviteId, …) as plain strings.
 * Use as a query value: `{ inviteId: idIn(invite._id) }`.
 */
export function idIn<T>(id: T): { $in: [T, string] } {
  return { $in: [id, String(id)] };
}
