import { summarizeInvites } from "./collaboration-record.util";

const inv = (id: string, status: string, extra: any = {}) => ({ _id: id, status, ...extra });

describe("collaboration record", () => {
  it("counts every outcome once, late vs on time, excused no-shows, and both rates", () => {
    const invites = [
      inv("a", "approved"),
      inv("b", "completed"),
      inv("c", "approved"), // late
      inv("d", "withdrawn", { withdrawnReasonCode: "expired_unsubmitted" }),
      inv("e", "withdrawn", { withdrawnReasonCode: "location_no_show", missExcused: { at: new Date() } }),
      inv("f", "withdrawn", { withdrawnReason: "Posting deadline and grace period expired with no submission." }), // legacy no-show
      inv("g", "withdrawn", { withdrawnReasonCode: "expired_unanswered" }),
      inv("h", "declined"),
      inv("i", "working"),
      inv("j", "counter_sent"),
      inv("k", "disputed"),
      inv("l", "invited"),
    ];
    const s = summarizeInvites(invites, new Set(["c"]));
    expect(s).toMatchObject({
      total: 12,
      completedOnTime: 2,
      completedLate: 1,
      didNotPost: 3,
      didNotPostExcused: 1,
      inProgress: 2, // working + counter offer
      disputed: 1,
      declined: 1,
      awaitingReply: 1,
      noResponse: 1,
      // 3 completed + 1 disputed + 3 didn't post + 1 working (counter not yet accepted)
      accepted: 8,
    });
    expect(s.acceptanceRate).toBe(Math.round((8 / 9) * 100));
    expect(s.completionRate).toBe(Math.round((3 / 7) * 100));
  });

  it("leaves rates empty with nothing answered or finished", () => {
    const s = summarizeInvites([inv("a", "invited")], new Set());
    expect(s.acceptanceRate).toBeNull();
    expect(s.completionRate).toBeNull();
  });
});
