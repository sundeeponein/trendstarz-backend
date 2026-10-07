import { BadRequestException } from "@nestjs/common";
import { CampaignCorrectionsService } from "./campaign-corrections.service";

const HOUR = 60 * 60 * 1000;
const REASON = "Host asked support: auto-close ran early";

/** A mongoose-ish document: plain fields + save(). */
function doc<T extends Record<string, any>>(fields: T) {
  const d: any = { ...fields };
  d.save = jest.fn().mockResolvedValue(d);
  return d as T & { save: jest.Mock };
}

describe("CampaignCorrectionsService", () => {
  let campaign: any;
  let invite: any;
  let txs: any[];
  let withdrawnEvent: any;
  let models: Record<string, any>;
  let invitesService: any;
  let platformEvents: any;
  let push: any;
  let notifications: any;
  let service: CampaignCorrectionsService;

  beforeEach(() => {
    campaign = doc({
      _id: "c24",
      title: "CMP-24",
      status: "active",
      postingDeadlineMode: "grace_24h",
      timelineStart: new Date("2026-10-01T00:00:00.000Z"),
      endDate: new Date(Date.now() + 3 * 24 * HOUR),
    });
    // CMP-24: paid, post date passed, withdrawn by the early auto-close.
    invite = doc({
      _id: "inv1",
      campaignId: "c24",
      influencerId: "creator1",
      status: "withdrawn",
      selectedPostDate: new Date(Date.now() - 2 * 24 * HOUR),
      paymentConfirmedAt: new Date(Date.now() - 7 * 24 * HOUR),
      withdrawnAt: new Date(),
      withdrawnReason: "Campaign's grace period ended with no submission.",
      adminCorrections: [],
    });
    txs = [
      {
        _id: "tx1",
        inviteId: "inv1",
        collectionStatus: "verified",
        payoutStatus: "skipped",
        resolveOutcome: "refund_to_brand",
      },
    ];
    withdrawnEvent = {
      metadata: {
        reason: "expired_unsubmitted",
        previousStatus: "payment_confirmed",
      },
    };

    models = {
      campaign: { findById: jest.fn(() => campaign) },
      invite: {
        findById: jest.fn(() => invite),
        updateOne: jest.fn().mockResolvedValue({}),
      },
      tx: {
        find: jest.fn(() => ({ lean: () => Promise.resolve(txs) })),
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      },
      influencer: {},
      photographer: {},
    };
    invitesService = {
      submitPost: jest.fn().mockResolvedValue({ success: true }),
      expireUnsubmittedInvite: jest
        .fn()
        .mockResolvedValue({ success: true, status: "withdrawn" }),
    };
    platformEvents = {
      findInviteWithdrawn: jest.fn(() => Promise.resolve(withdrawnEvent)),
    };
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };

    service = new CampaignCorrectionsService(
      models.campaign,
      models.invite,
      models.tx,
      models.influencer,
      models.photographer,
      invitesService,
      platformEvents,
      push,
      notifications,
    );
  });

  it("every action needs a reason", async () => {
    await expect(
      service.restoreParticipation(
        "inv1",
        { reason: "short", hostNotRefunded: true },
        "admin1",
      ),
    ).rejects.toThrow(/reason/);
    expect(invite.save).not.toHaveBeenCalled();
  });

  describe("restore participation", () => {
    it("CMP-24: back to payment_confirmed, withdrawal cleared, payment back to pending, fresh 48h, logged, creator notified", async () => {
      const before = Date.now();
      const res = await service.restoreParticipation(
        "inv1",
        { reason: REASON, hostNotRefunded: true },
        "admin1",
      );

      expect(invite.status).toBe("payment_confirmed");
      expect(invite.withdrawnAt).toBeUndefined();
      expect(invite.withdrawnReason).toBeUndefined();
      const ext = invite.submissionDeadlineExtendedTo.getTime();
      expect(ext).toBeGreaterThanOrEqual(before + 48 * HOUR);
      expect(invite.save).toHaveBeenCalled();
      // Logged by appending (never rewriting the admin-only log).
      expect(models.invite.updateOne).toHaveBeenCalledWith(
        { _id: "inv1" },
        {
          $push: {
            adminCorrections: expect.objectContaining({
              action: "restore_participation",
              reason: REASON,
              by: "admin1",
              details: expect.objectContaining({
                restoredTo: "payment_confirmed",
              }),
            }),
          },
        },
      );

      const [filter, update] = models.tx.updateMany.mock.calls[0];
      expect(filter.payoutStatus).toEqual({ $ne: "paid" });
      expect(update).toEqual({
        $set: {
          payoutStatus: "pending",
          workStatus: "pending",
          disputeStatus: "none",
        },
        $unset: { resolveOutcome: "", resolvedAt: "" },
      });
      expect(push.sendToUser).toHaveBeenCalledWith(
        "creator1",
        expect.objectContaining({ title: "Participation Restored" }),
        "campaign",
      );
      expect(res).toEqual(
        expect.objectContaining({ success: true, paymentsReset: 1 }),
      );
    });

    it("refuses while the payment says 'refund to host' unless the admin confirms no refund was made", async () => {
      await expect(
        service.restoreParticipation("inv1", { reason: REASON }, "admin1"),
      ).rejects.toThrow(/NOT been refunded/);
      expect(invite.save).not.toHaveBeenCalled();
      expect(models.tx.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      [
        "the host withdrew it",
        { metadata: { reason: "owner", previousStatus: "accepted" } },
      ],
      [
        "a dispute was decided for the host",
        { metadata: { reason: "dispute_refund", previousStatus: "disputed" } },
      ],
      [
        "it was never accepted",
        { metadata: { reason: "admin_cancel", previousStatus: "pending" } },
      ],
    ])("cannot undo when %s", async (_label, event) => {
      withdrawnEvent = event;
      await expect(
        service.restoreParticipation(
          "inv1",
          { reason: REASON, hostNotRefunded: true },
          "admin1",
        ),
      ).rejects.toThrow(BadRequestException);
      expect(invite.save).not.toHaveBeenCalled();
    });

    it("never touches a payout that was already paid", async () => {
      txs[0].payoutStatus = "paid";
      await expect(
        service.restoreParticipation(
          "inv1",
          { reason: REASON, hostNotRefunded: true },
          "admin1",
        ),
      ).rejects.toThrow(/already paid/);
    });

    it("needs an active campaign (extend/reopen first)", async () => {
      campaign.status = "completed";
      await expect(
        service.restoreParticipation(
          "inv1",
          { reason: REASON, hostNotRefunded: true },
          "admin1",
        ),
      ).rejects.toThrow(/extend\/reopen/);
    });

    it("older withdrawals without an event: recognised by the system's expiry message", async () => {
      withdrawnEvent = null;
      await service.restoreParticipation(
        "inv1",
        { reason: REASON, hostNotRefunded: true },
        "admin1",
      );
      expect(invite.status).toBe("payment_confirmed");
    });
  });

  describe("extend campaign end date", () => {
    it("moves endDate and timelineEnd together and logs the override", async () => {
      const target = new Date(Date.now() + 10 * 24 * HOUR)
        .toISOString()
        .slice(0, 10);
      const res = await service.extendEndDate(
        "c24",
        { endDate: target, reason: REASON },
        "admin1",
      );
      expect(campaign.endDate.toISOString().slice(0, 10)).toBe(target);
      expect(campaign.timelineEnd).toBe(campaign.endDate);
      expect(campaign.adminOverrideAction).toBe("extend_end_date");
      expect(campaign.adminOverrideBy).toBe("admin1");
      expect(res.reopened).toBe(false);
    });

    it("reopens a completed campaign", async () => {
      campaign.status = "completed";
      campaign.completedAt = new Date();
      campaign.completedBy = "auto";
      const target = new Date(Date.now() + 10 * 24 * HOUR)
        .toISOString()
        .slice(0, 10);
      const res = await service.extendEndDate(
        "c24",
        { endDate: target, reason: REASON },
        "admin1",
      );
      expect(res.reopened).toBe(true);
      expect(campaign.status).toBe("active");
      expect(campaign.completedAt).toBeNull();
      expect(campaign.completedBy).toBeNull();
    });

    it("only later dates, in YYYY-MM-DD, and never for cancelled campaigns", async () => {
      const earlier = new Date(Date.now() + 1 * 24 * HOUR)
        .toISOString()
        .slice(0, 10);
      await expect(
        service.extendEndDate(
          "c24",
          { endDate: earlier, reason: REASON },
          "admin1",
        ),
      ).rejects.toThrow(/later than the current/);
      await expect(
        service.extendEndDate(
          "c24",
          { endDate: "10/12/2026", reason: REASON },
          "admin1",
        ),
      ).rejects.toThrow(/YYYY-MM-DD/);
      campaign.status = "cancelled";
      await expect(
        service.extendEndDate(
          "c24",
          { endDate: "2027-01-01", reason: REASON },
          "admin1",
        ),
      ).rejects.toThrow(/active or completed/);
      expect(campaign.save).not.toHaveBeenCalled();
    });
  });

  describe("extend one creator's submission deadline", () => {
    beforeEach(() => {
      invite.status = "payment_confirmed";
      invite.selectedPostDate = new Date(Date.now() + 1 * 24 * HOUR);
    });

    it("sets the new deadline (later than the current one, within 7 days) and notifies", async () => {
      const until = new Date(Date.now() + 5 * 24 * HOUR).toISOString();
      await service.extendSubmissionDeadline(
        "inv1",
        { until, reason: REASON },
        "admin1",
      );
      expect(invite.submissionDeadlineExtendedTo.toISOString()).toBe(until);
      const [, update] = models.invite.updateOne.mock.calls[0];
      expect(update.$push.adminCorrections.action).toBe(
        "extend_submission_deadline",
      );
      expect(push.sendToUser).toHaveBeenCalled();
    });

    it("rejects more than 7 days, or a date not after the current deadline", async () => {
      await expect(
        service.extendSubmissionDeadline(
          "inv1",
          {
            until: new Date(Date.now() + 8 * 24 * HOUR).toISOString(),
            reason: REASON,
          },
          "admin1",
        ),
      ).rejects.toThrow(/at most 7 days/);
      await expect(
        service.extendSubmissionDeadline(
          "inv1",
          {
            until: new Date(Date.now() + 2 * HOUR).toISOString(),
            reason: REASON,
          },
          "admin1",
        ),
      ).rejects.toThrow(/later than the current/);
      expect(invite.save).not.toHaveBeenCalled();
    });

    it("not for submitted work", async () => {
      invite.status = "submitted";
      await expect(
        service.extendSubmissionDeadline(
          "inv1",
          {
            until: new Date(Date.now() + 5 * 24 * HOUR).toISOString(),
            reason: REASON,
          },
          "admin1",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("submit the post link on the creator's behalf", () => {
    beforeEach(() => {
      invite.status = "payment_confirmed";
      invite.selectedPostDate = new Date(Date.now() + 1 * 24 * HOUR);
    });

    it("goes through the normal submit flow as the creator, then logs it", async () => {
      await service.submitOnBehalf(
        "inv1",
        { postUrl: "https://instagram.com/p/abc", reason: REASON },
        "admin1",
      );
      expect(invitesService.submitPost).toHaveBeenCalledWith(
        "inv1",
        "creator1",
        {
          postUrl: "https://instagram.com/p/abc",
        },
      );
      const [, update] = models.invite.updateOne.mock.calls[0];
      expect(update.$push.adminCorrections).toEqual(
        expect.objectContaining({ action: "submit_on_behalf", by: "admin1" }),
      );
    });

    it("needs a full link and an open window", async () => {
      await expect(
        service.submitOnBehalf(
          "inv1",
          { postUrl: "instagram.com/p/abc", reason: REASON },
          "a",
        ),
      ).rejects.toThrow(/full post link/);
      invite.selectedPostDate = new Date(Date.now() - 10 * 24 * HOUR);
      await expect(
        service.submitOnBehalf(
          "inv1",
          { postUrl: "https://x.com/p/1", reason: REASON },
          "a",
        ),
      ).rejects.toThrow(/extend the deadline first/);
      expect(invitesService.submitPost).not.toHaveBeenCalled();
    });
  });

  describe("cancel one creator's participation", () => {
    beforeEach(() => {
      invite.status = "payment_confirmed";
    });

    it("uses the normal close-out, recorded as an admin cancellation", async () => {
      await service.cancelParticipation("inv1", { reason: REASON }, "admin1");
      expect(invitesService.expireUnsubmittedInvite).toHaveBeenCalledWith(
        "inv1",
        expect.any(String),
        {
          withdrawnReason: "admin_cancel",
          actor: { userId: "admin1", userRole: "admin" },
        },
      );
      expect(models.invite.updateOne).toHaveBeenCalled();
    });

    it("refuses after a payout was paid, or with an open host report", async () => {
      txs[0].payoutStatus = "paid";
      await expect(
        service.cancelParticipation("inv1", { reason: REASON }, "a"),
      ).rejects.toThrow(/already paid/);
      txs[0].payoutStatus = "pending";
      invite.reportedIssue = { reportedAt: new Date() };
      await expect(
        service.cancelParticipation("inv1", { reason: REASON }, "a"),
      ).rejects.toThrow(/Disputes page/);
      expect(invitesService.expireUnsubmittedInvite).not.toHaveBeenCalled();
    });
  });
});
