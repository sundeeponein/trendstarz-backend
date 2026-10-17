import {
  availabilityStateFrom,
  availabilityUpdate,
  normalizeCollaborationAvailability,
  storedAvailabilityState,
} from "./collaboration-availability.util";

describe("collaboration availability (Stage 3D-1d)", () => {
  const NOW = new Date("2026-10-09T10:00:00.000Z");
  const EARLIER = new Date("2026-09-01T00:00:00.000Z");
  const LATER = new Date("2026-10-20T00:00:00.000Z"); // a running "not available" period

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
      storedAvailabilityState({
        enabled: false,
        state: "not_available",
        notAvailableUntil: LATER,
      }),
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
      {
        enabled: false,
        state: "not_available",
        stateUpdatedAt: EARLIER,
        notAvailableUntil: LATER,
      },
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
      notAvailableUntil: LATER,
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

  describe("time-limited 'not available' (Option B)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const days = (n: number) => new Date(NOW.getTime() + n * DAY);

    it("the creator's choice of 1 week, 2 weeks or 1 month sets the end date", () => {
      for (const n of [7, 14, 30]) {
        const next = availabilityUpdate(
          { state: "not_available", notAvailableForDays: n },
          "influencer",
          null,
          NOW,
        );
        expect(next.notAvailableUntil).toEqual(days(n));
      }
    });

    it("no choice → the period already running, else 2 weeks; any other length is not accepted as days", () => {
      expect(
        availabilityUpdate({ state: "not_available" }, "influencer", null, NOW)
          .notAvailableUntil,
      ).toEqual(days(14));
      expect(
        availabilityUpdate(
          { state: "not_available", notAvailableForDays: 365 },
          "influencer",
          { state: "not_available", notAvailableUntil: LATER },
          NOW,
        ).notAvailableUntil,
      ).toEqual(LATER);
    });

    it("a date sent by the browser is kept within 1 to 31 days", () => {
      const until = (d: Date) =>
        availabilityUpdate(
          { state: "not_available", notAvailableUntil: d.toISOString() },
          "influencer",
          null,
          NOW,
        ).notAvailableUntil;
      expect(until(days(10))).toEqual(days(10));
      expect(until(days(400))).toEqual(days(31));
      expect(until(days(-5))).toEqual(days(1));
    });

    it("an ended period reads as not set (even before the daily reset runs)", () => {
      const ended = { state: "not_available", notAvailableUntil: EARLIER };
      expect(storedAvailabilityState(ended, NOW)).toBeNull();
      // A period set before durations existed ends 14 days after it was chosen.
      const legacy = { state: "not_available", stateUpdatedAt: days(-20) };
      expect(storedAvailabilityState(legacy, NOW)).toBeNull();
      const recent = { state: "not_available", stateUpdatedAt: days(-3) };
      expect(storedAvailabilityState(recent, NOW)).toBe("not_available");
    });

    it("being available clears the end date", () => {
      const next = availabilityUpdate(
        { state: "available" },
        "influencer",
        { state: "not_available", notAvailableUntil: LATER },
        NOW,
      );
      expect(next).toMatchObject({
        state: "available",
        notAvailableUntil: null,
      });
    });
  });
});
