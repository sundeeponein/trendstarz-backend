import { WORKFLOW_TIMING_DEFAULTS, settingHours } from "./workflow-timing.util";

describe("settingHours", () => {
  it("uses the saved value when it is a valid number of hours (0 included)", () => {
    expect(
      settingHours(
        { disputeResponseWaitHours: 30 },
        "disputeResponseWaitHours",
      ),
    ).toBe(30);
    expect(
      settingHours({ disputeResponseWaitHours: 0 }, "disputeResponseWaitHours"),
    ).toBe(0);
    expect(
      settingHours(
        { disputeResponseWaitHours: "6" },
        "disputeResponseWaitHours",
      ),
    ).toBe(6);
  });

  it("falls back to the default when missing, null, negative or not a number", () => {
    const d = WORKFLOW_TIMING_DEFAULTS.submissionAutoCompleteGraceHours;
    expect(d).toBe(48);
    for (const settings of [
      null,
      {},
      { submissionAutoCompleteGraceHours: null },
      { submissionAutoCompleteGraceHours: -1 },
      { submissionAutoCompleteGraceHours: "abc" },
    ]) {
      expect(settingHours(settings, "submissionAutoCompleteGraceHours")).toBe(
        d,
      );
    }
  });

  it("defaults match the admin settings page", () => {
    expect(WORKFLOW_TIMING_DEFAULTS).toEqual({
      submissionApprovalWaitHours: 24,
      submissionAutoCompleteGraceHours: 48,
      payoutReleaseWaitHours: 24,
      disputeResponseWaitHours: 12,
      campaignAutoCloseGraceHours: 24,
    });
  });
});
