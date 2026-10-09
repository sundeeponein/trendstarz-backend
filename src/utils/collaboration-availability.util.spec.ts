import {
  availabilityStateFrom,
  availabilityUpdate,
  normalizeCollaborationAvailability,
  storedAvailabilityState,
} from "./collaboration-availability.util";

describe("collaboration availability (Stage 3D-1d)", () => {
  const NOW = new Date("2026-10-09T10:00:00.000Z");
  const EARLIER = new Date("2026-09-01T00:00:00.000Z");

  it("an explicit state wins over enabled", () => {
    expect(availabilityStateFrom({ state: "available" })).toBe("available");
    expect(
      availabilityStateFrom({ state: "not_available", enabled: true }),
    ).toBe("not_available");
  });

  it("no valid state (untouched form, older client) falls back to enabled", () => {
    // A legacy "on" profile saved from an untouched form stays available.
    expect(availabilityStateFrom({ state: null, enabled: true })).toBe(
      "available",
    );
    expect(
      availabilityStateFrom({ state: "unset", enabled: false }),
    ).toBeNull();
  });

  it("an older client's enabled: true is available; enabled: false is never set (not 'no')", () => {
    expect(availabilityStateFrom({ enabled: true })).toBe("available");
    expect(availabilityStateFrom({ enabled: false })).toBeNull();
    expect(availabilityStateFrom(undefined)).toBeNull();
  });

  it("enabled is derived from the state, so existing readers keep working", () => {
    expect(
      normalizeCollaborationAvailability({ state: "available" }, "influencer"),
    ).toMatchObject({ enabled: true, state: "available" });
    expect(
      normalizeCollaborationAvailability(
        { state: "not_available", enabled: true, availableFor: ["Reels"] },
        "influencer",
      ),
    ).toMatchObject({
      enabled: false,
      state: "not_available",
      availableFor: [],
    });
  });

  it("legacy stored profiles: enabled → available, otherwise never set", () => {
    expect(storedAvailabilityState({ enabled: true })).toBe("available");
    expect(storedAvailabilityState({ enabled: false })).toBeNull();
    expect(
      storedAvailabilityState({ enabled: false, state: "not_available" }),
    ).toBe("not_available");
  });

  it("dates a change of state now and keeps the date when unchanged", () => {
    const changed = availabilityUpdate(
      { state: "not_available" },
      "photographer",
      { enabled: true, state: "available", stateUpdatedAt: EARLIER },
      NOW,
    );
    expect(changed).toMatchObject({
      state: "not_available",
      stateUpdatedAt: NOW,
    });
    const same = availabilityUpdate(
      { state: "available" },
      "photographer",
      { enabled: true, state: "available", stateUpdatedAt: EARLIER },
      NOW,
    );
    expect(same.stateUpdatedAt).toEqual(EARLIER);
    // A legacy "on" profile confirming "available" isn't a change either (no date yet).
    const legacy = availabilityUpdate(
      { state: "available" },
      "influencer",
      { enabled: true },
      NOW,
    );
    expect(legacy.stateUpdatedAt).toBeNull();
  });

  it("an older client sending only enabled: false never downgrades an explicit 'not available'", () => {
    const next = availabilityUpdate(
      { enabled: false },
      "influencer",
      { enabled: false, state: "not_available", stateUpdatedAt: EARLIER },
      NOW,
    );
    expect(next).toMatchObject({
      state: "not_available",
      stateUpdatedAt: EARLIER,
    });
  });

  it("saving another part of the profile from an untouched form changes nothing", () => {
    const stored = {
      enabled: false,
      state: "not_available",
      stateUpdatedAt: EARLIER,
    };
    const next = availabilityUpdate(
      { state: null, enabled: false },
      "influencer",
      stored,
      NOW,
    );
    expect(next).toMatchObject({
      enabled: false,
      state: "not_available",
      stateUpdatedAt: EARLIER,
    });
  });
});
