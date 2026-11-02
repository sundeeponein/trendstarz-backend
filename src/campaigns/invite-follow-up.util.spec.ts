import { buildFollowUp, waitingStage } from "./invite-follow-up.util";

describe("invite follow-up", () => {
  const t = (s: string) => new Date(`2026-11-0${s}T10:00:00Z`);

  it("knows who must act next", () => {
    expect(waitingStage({ status: "invited", createdAt: t("1") })).toMatchObject({ waitingOn: "creator", reason: "Reply to invite" });
    expect(waitingStage({ status: "counter_sent", counterOffer: { status: "sent", sentAt: t("1") } }).waitingOn).toBe("host");
    expect(waitingStage({ status: "counter_sent", counterOffer: { status: "brand_sent", sentAt: t("1") } }).waitingOn).toBe("creator");
    expect(waitingStage({ status: "accepted", acceptedAt: t("1") }, "paid_collab")).toMatchObject({ waitingOn: "host", reason: "Pay to confirm the creator" });
    expect(waitingStage({ status: "accepted", acceptedAt: t("1") }, "barter").reason).toBe("Confirm the creator");
    expect(waitingStage({ status: "working" }).waitingOn).toBeNull();
  });

  it("counts a view or login only if it came after the wait started", () => {
    const f = buildFollowUp({
      invite: { status: "accepted", acceptedAt: t("2") },
      campaignType: "paid_collab",
      hostView: { lastAt: t("1") }, // opened before the creator accepted
      host: { lastLoginAt: t("3") },
      creatorView: { firstAt: t("1"), lastAt: t("1") },
    });
    expect(f).toMatchObject({ waitingOn: "host", seenSince: false, activeSince: true });
    expect(f.creatorFirstSeenAt).toEqual(t("1"));
  });
});
