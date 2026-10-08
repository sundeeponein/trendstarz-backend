import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "./profile-selection-limits.util";

export type CollaborationAvailabilityRole = "influencer" | "photographer";

function cleanList(value: unknown, limit = 20): string[] {
  return normalizeSelectionList(value, limit);
}

export function normalizeCollaborationAvailability(
  value: any,
  role: CollaborationAvailabilityRole,
) {
  const enabled = value?.enabled === true;
  const availableForLimit =
    role === "influencer"
      ? PROFILE_SELECTION_LIMITS.influencer.availableFor
      : PROFILE_SELECTION_LIMITS.photographer.availableFor;
  const base: any = {
    enabled,
    availableFor: enabled ? cleanList(value?.availableFor, availableForLimit) : [],
    preference: enabled ? String(value?.preference || "").trim() : "",
    openToTravel: enabled ? value?.openToTravel === true : false,
  };

  if (role === "influencer") {
    base.collaborationTypes = enabled
      ? cleanList(
          value?.collaborationTypes,
          PROFILE_SELECTION_LIMITS.influencer.collaborationTypes,
        )
      : [];
  }

  return base;
}
