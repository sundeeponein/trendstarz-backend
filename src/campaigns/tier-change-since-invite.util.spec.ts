import { tierChangesSinceInvite } from "./tier-change-since-invite.util";

describe("tierChangesSinceInvite", () => {
  const SENT = new Date("2026-10-05T00:00:00.000Z");
  const after = new Date("2026-10-10T03:00:00.000Z");
  const before = new Date("2026-10-01T00:00:00.000Z");
  const social = [
    {
      platform: "YouTube",
      platformKey: "youtube",
      tier: "Micro",
      tierChangedAt: after,
    },
    {
      platform: "Instagram",
      platformKey: "instagram",
      tier: "Nano",
      tierChangedAt: before,
    },
  ];
  const invite = (over: Record<string, any> = {}) => ({
    status: "pending",
    createdAt: SENT,
    campaignId: { platforms: ["YouTube", "Instagram"] },
    ...over,
  });

  it("an open invite shows a tier changed after it was sent", () => {
    expect(tierChangesSinceInvite(social, invite())).toEqual([
      { platform: "YouTube", tier: "Micro", changedAt: after },
    ]);
  });

  it("agreed, paid or closed invites never show it (their amount never changes)", () => {
    for (const status of [
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "declined",
      "withdrawn",
      "counter_sent",
    ]) {
      expect(tierChangesSinceInvite(social, invite({ status }))).toEqual([]);
    }
  });

  it("only the campaign's platforms count", () => {
    expect(
      tierChangesSinceInvite(
        social,
        invite({ campaignId: { platforms: ["Instagram"] } }),
      ),
    ).toEqual([]);
    // A campaign without listed platforms: any account.
    expect(
      tierChangesSinceInvite(social, invite({ campaignId: {} })),
    ).toHaveLength(1);
  });
});
