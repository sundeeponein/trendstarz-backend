import type { Model } from "mongoose";

/**
 * Each role lives in its own collection, so the per-collection unique index on
 * email can't stop the same email (or phone) belonging to an influencer AND a
 * brand/photographer/admin. Login and password reset look an email up across
 * all of them, so it must identify exactly one account. Registration already
 * checks this; profile edits use the same check through here.
 */
export interface AccountModels {
  influencer: Model<any>;
  brand: Model<any>;
  photographer: Model<any>;
  user: Model<any>;
}

function exactEmail(email: string): RegExp {
  return new RegExp(
    `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
  );
}

/**
 * Fields ("email" / "phoneNumber") that another account already uses.
 * `selfId` is the account being edited — its own current values don't count.
 */
export async function takenAccountFields(
  models: AccountModels,
  input: { email?: string | null; phoneNumber?: string | null },
  selfId: string,
): Promise<string[]> {
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.phoneNumber || "").trim();
  const notSelf = { _id: { $ne: selfId } };
  const all = [models.influencer, models.brand, models.photographer, models.user];
  const [emailHits, phoneHits] = await Promise.all([
    email
      ? Promise.all(
          all.map((m) => m.exists({ email: exactEmail(email), ...notSelf })),
        )
      : Promise.resolve([]),
    phone
      ? Promise.all(all.map((m) => m.exists({ phoneNumber: phone, ...notSelf })))
      : Promise.resolve([]),
  ]);
  const taken: string[] = [];
  if (emailHits.some(Boolean)) taken.push("email");
  if (phoneHits.some(Boolean)) taken.push("phoneNumber");
  return taken;
}
