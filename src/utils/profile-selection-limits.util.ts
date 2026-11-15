export const PROFILE_SELECTION_LIMITS = {
  influencer: {
    categories: 5,
    creatorTypes: 3,
    collaborationTypes: 3,
    availableFor: 2,
  },
  photographer: {
    skills: 3,
    availableFor: 2,
  },
} as const;

/**
 * The creator's main category (stored as influencerCategory), only if it is one
 * of their own categories — returned in that list's spelling; otherwise "".
 * Shared by profile saves and matching (2026-11-15).
 */
export function mainCategoryWithin(main: unknown, categories: unknown): string {
  const wanted = String(main ?? "").trim().toLowerCase();
  if (!wanted || !Array.isArray(categories)) return "";
  const hit = categories.find(
    (c) => String(c ?? "").trim().toLowerCase() === wanted,
  );
  return hit === undefined ? "" : String(hit).trim();
}

export function normalizeSelectionList(
  value: unknown,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
