import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "./profile-selection-limits.util";

export type CollaborationAvailabilityRole = "influencer" | "photographer";

function cleanList(value: unknown, limit = 20): string[] {
  return normalizeSelectionList(value, limit);
}

/** 3D-1d: what the creator chose. null = never set (not the same as "not available"). */
export type AvailabilityState = "available" | "not_available" | null;

const AVAILABILITY_STATES = ["available", "not_available"];

/**
 * The state from a save. A valid `state` ("available" / "not_available") is the
 * creator's explicit choice. Anything else (missing, null, unknown — e.g. an
 * untouched form or an older client) falls back to `enabled`: true → available,
 * false → never set. Before 3D-1d "off" was also the untouched default, so it is
 * never read as an explicit "no". The creator form offers only the two choices.
 */
export function availabilityStateFrom(value: any): AvailabilityState {
  if (AVAILABILITY_STATES.includes(value?.state)) {
    return value.state as AvailabilityState;
  }
  return value?.enabled === true ? "available" : null;
}

/** The state of a stored profile (legacy docs without `state`: enabled → available, else never set). */
export function storedAvailabilityState(stored: any): AvailabilityState {
  const state = stored?.state;
  if (AVAILABILITY_STATES.includes(state)) return state as AvailabilityState;
  return stored?.enabled === true ? "available" : null;
}

/**
 * Server-owned date of the last change of state: `now` when the state differs
 * from the stored one, else the stored date (null if it never changed since 3D-1d).
 */
export function withAvailabilityTimestamp<T extends Record<string, any>>(
  next: T,
  stored: any,
  now: Date = new Date(),
): T & { stateUpdatedAt: Date | null } {
  const changed = (next.state ?? null) !== storedAvailabilityState(stored);
  return {
    ...next,
    stateUpdatedAt: changed ? now : (stored?.stateUpdatedAt ?? null),
  };
}

export function normalizeCollaborationAvailability(
  value: any,
  role: CollaborationAvailabilityRole,
) {
  const state = availabilityStateFrom(value);
  // `enabled` stays the field existing readers use: true only when available.
  const enabled = state === "available";
  const availableForLimit =
    role === "influencer"
      ? PROFILE_SELECTION_LIMITS.influencer.availableFor
      : PROFILE_SELECTION_LIMITS.photographer.availableFor;
  const base: any = {
    enabled,
    state,
    availableFor: enabled
      ? cleanList(value?.availableFor, availableForLimit)
      : [],
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

/**
 * A creator's availability save, ready to store: normalized, with the
 * server-owned stateUpdatedAt. An older client that sends only `enabled: false`
 * never downgrades an explicit "not available" to "never set".
 */
export function availabilityUpdate(
  value: any,
  role: CollaborationAvailabilityRole,
  stored: any,
  now: Date = new Date(),
) {
  const next = normalizeCollaborationAvailability(value, role);
  const explicit = AVAILABILITY_STATES.includes(value?.state);
  if (
    !explicit &&
    next.state === null &&
    storedAvailabilityState(stored) === "not_available"
  ) {
    next.state = "not_available";
  }
  return withAvailabilityTimestamp(next, stored, now);
}
