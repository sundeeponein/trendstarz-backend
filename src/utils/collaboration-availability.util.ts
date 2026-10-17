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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Not available" is always time-limited (Option B): the creator picks one of
 * these; when it ends they go back to "not set" and get one reminder. A creator
 * who forgets the app is never stuck as unavailable.
 */
export const NOT_AVAILABLE_DAY_OPTIONS = [7, 14, 30] as const;
export const DEFAULT_NOT_AVAILABLE_DAYS = 14;
const MAX_NOT_AVAILABLE_DAYS = 31;

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * When a stored "not available" ends: its notAvailableUntil, or (for one saved
 * before durations existed) DEFAULT_NOT_AVAILABLE_DAYS after it was set; null
 * when there is no date to go on (treated as already ended).
 */
export function notAvailableEndsAt(stored: any): Date | null {
  const until = validDate(stored?.notAvailableUntil);
  if (until) return until;
  const since = validDate(stored?.stateUpdatedAt);
  return since
    ? new Date(since.getTime() + DEFAULT_NOT_AVAILABLE_DAYS * DAY_MS)
    : null;
}

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

/**
 * The state of a stored profile right now. Legacy docs without `state`: enabled →
 * available, else never set. A "not available" whose period has ended reads as
 * never set, even before the daily expiry job has reset it.
 */
export function storedAvailabilityState(
  stored: any,
  now: Date = new Date(),
): AvailabilityState {
  const state = stored?.state;
  if (state === "not_available") {
    const ends = notAvailableEndsAt(stored);
    return ends && ends.getTime() > now.getTime() ? "not_available" : null;
  }
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
  const changed = (next.state ?? null) !== storedAvailabilityState(stored, now);
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
    // Set by availabilityUpdate (server-owned); only meaningful while not available.
    notAvailableUntil: null,
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
  const storedState = storedAvailabilityState(stored, now);
  if (!explicit && next.state === null && storedState === "not_available") {
    next.state = "not_available";
  }
  if (next.state === "not_available") {
    next.notAvailableUntil = notAvailableUntilFor(
      value,
      stored,
      storedState,
      now,
    );
  }
  return withAvailabilityTimestamp(next, stored, now);
}

/**
 * The end of a "not available" period: the creator's choice of days (7/14/30),
 * else a date they sent (kept between 1 and 31 days from now), else the period
 * already running, else the default 14 days.
 */
function notAvailableUntilFor(
  value: any,
  stored: any,
  storedState: AvailabilityState,
  now: Date,
): Date {
  const days = Number(value?.notAvailableForDays);
  if ((NOT_AVAILABLE_DAY_OPTIONS as readonly number[]).includes(days)) {
    return new Date(now.getTime() + days * DAY_MS);
  }
  const sent = validDate(value?.notAvailableUntil);
  if (sent) {
    const min = now.getTime() + DAY_MS;
    const max = now.getTime() + MAX_NOT_AVAILABLE_DAYS * DAY_MS;
    return new Date(Math.min(Math.max(sent.getTime(), min), max));
  }
  if (storedState === "not_available") {
    const ends = notAvailableEndsAt(stored);
    if (ends) return ends;
  }
  return new Date(now.getTime() + DEFAULT_NOT_AVAILABLE_DAYS * DAY_MS);
}
