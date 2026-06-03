export type CollaborationAvailabilityRole = "influencer" | "photographer";

function cleanList(value: unknown, limit = 20): string[] {
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

export function normalizeCollaborationAvailability(
  value: any,
  role: CollaborationAvailabilityRole,
) {
  const enabled = value?.enabled === true;
  const base: any = {
    enabled,
    availableFor: enabled ? cleanList(value?.availableFor) : [],
    preference: enabled ? String(value?.preference || "").trim() : "",
    openToTravel: enabled ? value?.openToTravel === true : false,
  };

  if (role === "influencer") {
    base.collaborationTypes = enabled ? cleanList(value?.collaborationTypes) : [];
  }

  return base;
}
