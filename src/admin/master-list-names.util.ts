import type { ClientSession, Model } from "mongoose";
import { withSession } from "../utils/mongo-transaction.util";
import { normalizeCommunityStateKey } from "../utils/whatsapp-community-config.util";

/**
 * Categories, languages and states are stored on profiles and campaigns by
 * NAME, not by reference. So renaming one in the admin lists must rewrite the
 * name everywhere it is held, and deleting one that is still held would leave
 * orphaned names behind. This file knows every place each list's names live.
 */
export type MasterListKind = "category" | "language" | "state";

export interface NameHolderModels {
  influencer: Model<any>;
  brand: Model<any>;
  photographer: Model<any>;
  campaign: Model<any>;
  user: Model<any>;
  district: Model<any>;
  whatsappCommunity: Model<any>;
}

type Holder = { model: keyof NameHolderModels; path: string; array: boolean };

/**
 * Where a name is held. Category names are per role: influencer categories
 * live in influencers.categories (+ influencerCategory), brand ones in
 * brands.categories, photographer ones in photographers.skills; campaigns
 * target influencer/photographer categories. "both"/unset covers all.
 */
export function nameHolders(kind: MasterListKind, role?: string): Holder[] {
  if (kind === "language") {
    return [
      { model: "influencer", path: "languages", array: true },
      { model: "brand", path: "languages", array: true },
      { model: "campaign", path: "languages", array: true },
    ];
  }
  if (kind === "state") {
    return [
      { model: "influencer", path: "location.state", array: false },
      { model: "brand", path: "location.state", array: false },
      { model: "photographer", path: "location.state", array: false },
      { model: "influencer", path: "communityState", array: false },
      { model: "brand", path: "communityState", array: false },
      { model: "photographer", path: "communityState", array: false },
      { model: "user", path: "communityState", array: false },
      { model: "campaign", path: "targetState", array: false },
      { model: "campaign", path: "venueState", array: false },
      { model: "district", path: "state", array: false },
      { model: "whatsappCommunity", path: "state", array: false },
    ];
  }
  const r = String(role || "both").toLowerCase();
  const influencer: Holder[] = [
    { model: "influencer", path: "categories", array: true },
    { model: "influencer", path: "influencerCategory", array: false },
  ];
  const brand: Holder[] = [{ model: "brand", path: "categories", array: true }];
  const photographer: Holder[] = [
    { model: "photographer", path: "skills", array: true },
  ];
  const campaign: Holder[] = [
    { model: "campaign", path: "categories", array: true },
  ];
  if (r === "influencer") return [...influencer, ...campaign];
  if (r === "brand") return brand;
  if (r === "photographer") return [...photographer, ...campaign];
  return [...influencer, ...brand, ...photographer, ...campaign];
}

/** How many documents still hold `name`, per holder (only non-zero entries). */
export async function countNameUsage(
  models: NameHolderModels,
  kind: MasterListKind,
  name: string,
  role?: string,
  session?: ClientSession,
): Promise<{ total: number; byHolder: Record<string, number> }> {
  const byHolder: Record<string, number> = {};
  let total = 0;
  for (const h of nameHolders(kind, role)) {
    const n = await models[h.model].countDocuments(
      { [h.path]: name },
      withSession({}, session),
    );
    if (n > 0) {
      byHolder[`${h.model}.${h.path}`] = n;
      total += n;
    }
  }
  return { total, byHolder };
}

/**
 * Rewrites `oldName` → `newName` everywhere it is held. Arrays keep one copy
 * (a document that already had both names just loses the old one). Pass the
 * session so it commits together with the master-list change.
 */
export async function renameEverywhere(
  models: NameHolderModels,
  kind: MasterListKind,
  oldName: string,
  newName: string,
  role?: string,
  session?: ClientSession,
): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  if (!oldName || !newName || oldName === newName) return changed;
  for (const h of nameHolders(kind, role)) {
    const model = models[h.model];
    let n = 0;
    if (h.array) {
      const dedup = await model.updateMany(
        { [h.path]: { $all: [oldName, newName] } },
        { $pull: { [h.path]: oldName } },
        withSession({}, session),
      );
      const renamed = await model.updateMany(
        { [h.path]: oldName },
        { $set: { [`${h.path}.$[el]`]: newName } },
        withSession({ arrayFilters: [{ el: oldName }] }, session),
      );
      n = Number(dedup?.modifiedCount || 0) + Number(renamed?.modifiedCount || 0);
    } else {
      const set: Record<string, unknown> = { [h.path]: newName };
      // Community links are looked up by a key derived from the state name.
      if (h.model === "whatsappCommunity") {
        set.stateKey = normalizeCommunityStateKey(newName);
      }
      const res = await model.updateMany(
        { [h.path]: oldName },
        { $set: set },
        withSession({}, session),
      );
      n = Number(res?.modifiedCount || 0);
    }
    if (n > 0) changed[`${h.model}.${h.path}`] = n;
  }
  return changed;
}
