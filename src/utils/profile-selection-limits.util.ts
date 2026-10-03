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
