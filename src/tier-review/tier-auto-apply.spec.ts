import { autoTierDecision } from "./tier-auto-apply";

describe("automatic tier correction from YouTube (safeguards)", () => {
  const NOW = new Date("2026-10-10T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const ID = "64b0000000000000000000a1";
  const entry = (over: Record<string, any> = {}) => ({
    socialAccountId: ID,
    platformKey: "youtube",
    platform: "YouTube",
    handle: "@smiley__boie",
    tier: "Starter",
    ...over,
  });
  const obs = (over: Record<string, any> = {}) => ({
    socialAccountId: ID,
    platformKey: "youtube",
    source: "youtube",
    status: "success",
    externalAccountId: "UCabcdefghijklmnopqrstuv",
    observedHandle: "smiley__boie",
    observedFollowersCount: 815,
    capturedAt: new Date(NOW.getTime() - 1 * DAY),
    ...over,
  });
  const decide = (o: { e?: any; ob?: any; v?: any } = {}) =>
    autoTierDecision({
      entry: o.e ?? entry(),
      observation: o.ob === undefined ? obs() : o.ob,
      verification: o.v ?? null,
      now: NOW,
    });

  it("moves Starter → Nano when everything checks out", () => {
    expect(decide()).toEqual({
      apply: true,
      action: "change",
      fromTier: "Starter",
      toTier: "Nano",
      direction: "up",
      followers: 815,
      capturedAt: obs().capturedAt,
    });
  });

  it.each([
    ["not YouTube", { e: entry({ platformKey: "instagram" }) }, "not_youtube"],
    ["no observation", { ob: null }, "not_youtube"],
    [
      "count cleared or 0",
      { ob: obs({ observedFollowersCount: null }) },
      "no_count",
    ],
    ["failed lookup", { ob: obs({ status: "failed" }) }, "no_count"],
    [
      "older than 30 days",
      { ob: obs({ capturedAt: new Date(NOW.getTime() - 31 * DAY) }) },
      "stale",
    ],
    [
      "another channel's handle",
      { ob: obs({ observedHandle: "someone_else" }) },
      "handle_mismatch",
    ],
    [
      "within 5% of a tier boundary",
      { ob: obs({ observedFollowersCount: 1010 }) },
      "near_boundary",
    ],
  ])("skips: %s", (_label, o: any, reason) => {
    expect(decide(o)).toEqual({ apply: false, reason });
  });

  it("an admin decision made after the observation always wins", () => {
    const v = {
      tier: {
        status: "verified",
        method: "manual",
        decidedTier: "Starter",
        decidedAt: new Date(NOW.getTime() - 0.5 * DAY),
      },
    };
    expect(decide({ v })).toEqual({ apply: false, reason: "admin_decided" });
    // A decision from before the observation does not block it.
    const older = {
      tier: { ...v.tier, decidedAt: new Date(NOW.getTime() - 5 * DAY) },
    };
    expect(decide({ v: older }).apply).toBe(true);
  });

  it("upgrades every time subscribers grow, even after an earlier automatic change", () => {
    const v = {
      tierAutoAppliedAt: new Date(NOW.getTime() - 20 * DAY),
      tier: { status: "verified", method: "auto", decidedTier: "Starter" },
    };
    expect(decide({ v })).toMatchObject({
      apply: true,
      direction: "up",
      toTier: "Nano",
    });
  });

  it("downgrades only once: a later drop waits for a person", () => {
    const fewer = {
      e: entry({ tier: "Micro" }),
      ob: obs({ observedFollowersCount: 815 }),
    };
    expect(decide(fewer)).toMatchObject({
      apply: true,
      direction: "down",
      toTier: "Nano",
    });
    const v = { tierAutoAppliedAt: new Date(NOW.getTime() - 20 * DAY) };
    expect(decide({ ...fewer, v })).toEqual({
      apply: false,
      reason: "already_auto_corrected",
    });
  });

  it("stops entirely once the creator changed the tier themselves after an automatic change", () => {
    const v = {
      tierAutoAppliedAt: new Date(NOW.getTime() - 20 * DAY),
      tier: {
        status: "pending",
        invalidatedReason: "tier_changed",
        invalidatedAt: new Date(NOW.getTime() - 10 * DAY),
      },
    };
    expect(decide({ v })).toEqual({ apply: false, reason: "creator_override" });
  });

  describe("already the right tier → verify (no change)", () => {
    const right = { e: entry({ tier: "Nano" }) };

    it("verifies a never-reviewed (or changed) account quietly", () => {
      expect(decide(right)).toEqual({
        apply: true,
        action: "verify",
        tier: "Nano",
        followers: 815,
        capturedAt: obs().capturedAt,
      });
    });

    it("leaves an already verified account alone", () => {
      const v = {
        tier: {
          status: "verified",
          method: "manual",
          decidedTier: "Nano",
          decidedAt: new Date(NOW.getTime() - 9 * DAY),
        },
      };
      expect(decide({ ...right, v })).toEqual({
        apply: false,
        reason: "already_verified",
      });
    });

    it("never overrides an admin rejection", () => {
      const v = {
        tier: {
          status: "rejected",
          method: "manual",
          decidedTier: "Nano",
          decidedAt: new Date(NOW.getTime() - 9 * DAY),
        },
      };
      expect(decide({ ...right, v })).toEqual({
        apply: false,
        reason: "admin_rejected",
      });
    });

    it("the same safeguards apply (e.g. another channel's handle)", () => {
      expect(
        decide({ ...right, ob: obs({ observedHandle: "someone_else" }) }),
      ).toEqual({
        apply: false,
        reason: "handle_mismatch",
      });
    });
  });
});
