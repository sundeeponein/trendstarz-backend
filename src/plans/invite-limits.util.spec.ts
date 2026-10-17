import { receivedInvitesPerMonthFrom } from "./invite-limits.util";

describe("receivedInvitesPerMonthFrom", () => {
  it("uses the plan's own receive limit when set", () => {
    expect(
      receivedInvitesPerMonthFrom([
        { key: "maxInvitesPerCampaign", value: 1 },
        { key: "maxInvitesReceivedPerMonth", value: 2 },
      ]),
    ).toBe(2);
  });

  it("falls back to the per-campaign value (the old shared behaviour)", () => {
    expect(
      receivedInvitesPerMonthFrom([{ key: "maxInvitesPerCampaign", value: 5 }]),
    ).toBe(5);
  });

  it("keeps -1 (unlimited) and returns null when neither is set", () => {
    expect(
      receivedInvitesPerMonthFrom([
        { key: "maxInvitesReceivedPerMonth", value: -1 },
      ]),
    ).toBe(-1);
    expect(receivedInvitesPerMonthFrom([])).toBeNull();
    expect(receivedInvitesPerMonthFrom(undefined)).toBeNull();
    expect(
      receivedInvitesPerMonthFrom([
        { key: "maxInvitesReceivedPerMonth", value: "x" },
      ]),
    ).toBeNull();
  });
});
