jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));

import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { FakeCollection } from "../payments-payouts/fake-collection.fixture-spec";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlansService } from "../plans/plans.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PlatformEventsService } from "../platform-events/platform-events.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";
import { TrackingLinksService } from "./tracking-links.service";

const INVITE = "64b000000000000000000001";
const CAMPAIGN = "64b0000000000000000000c1";
const DAY = 24 * 60 * 60 * 1000;

/** Invite collection whose findById returns a saveable document (like Mongoose). */
class InviteCollection extends FakeCollection {
  constructor(docs: any[]) {
    super(docs);
    this.findById = jest.fn((id: any) => {
      const stored = this.get(id);
      if (!stored)
        return {
          select: () => ({ lean: () => Promise.resolve(null) }),
          lean: () => Promise.resolve(null),
        } as any;
      const doc: any = structuredClone(stored);
      const plain = () => Promise.resolve(structuredClone(this.get(id)));
      // Non-enumerable, so structuredClone(doc) below copies only the data fields.
      Object.defineProperties(doc, {
        save: {
          value: () => {
            const idx = this.docs.findIndex(
              (d) => String(d._id) === String(id),
            );
            this.docs[idx] = structuredClone(doc);
            return Promise.resolve(doc);
          },
        },
        select: { value: () => ({ lean: plain }) },
        lean: { value: plain },
      });
      return doc;
    }) as any;
  }
}

const inertService = (): any =>
  new Proxy(
    {},
    {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol"
          ? undefined
          : jest.fn().mockResolvedValue(undefined),
    },
  );

const txRow = (over: Record<string, any> = {}) => ({
  _id: "tx1",
  campaignId: CAMPAIGN,
  inviteId: INVITE,
  transactionType: "paid_collab",
  collectionStatus: "verified",
  payoutStatus: "skipped",
  payerId: "host1",
  payerRole: "brand",
  recipientId: "creator1",
  recipientRole: "influencer",
  payerTotal: 55000,
  ...over,
});

describe("Paid-collaboration safeguards (CampaignInvitesService)", () => {
  let service: CampaignInvitesService;
  let invites: InviteCollection;
  let txs: FakeCollection;
  let submissions: FakeCollection;
  let push: { sendToUser: jest.Mock };
  let notifications: { createForUser: jest.Mock };

  async function build(inviteRows: any[], txRows: any[] = []) {
    invites = new InviteCollection(inviteRows);
    txs = new FakeCollection(txRows);
    submissions = new FakeCollection([]);
    (submissions as any).create = jest.fn((d: any) => {
      const doc = { _id: "sub1", ...d };
      submissions.docs.push(doc);
      return Promise.resolve(doc);
    });
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const empty = new FakeCollection([]);
    const module = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: invites },
        { provide: getModelToken("CampaignSubmission"), useValue: submissions },
        {
          provide: getModelToken("Campaign"),
          useValue: new FakeCollection([
            { _id: CAMPAIGN, title: "Diwali Reels", status: "active" },
          ]),
        },
        {
          provide: getModelToken("Brand"),
          useValue: new FakeCollection([{ _id: "host1", brandName: "Acme" }]),
        },
        { provide: getModelToken("Photographer"), useValue: empty },
        { provide: getModelToken("Influencer"), useValue: empty },
        { provide: getModelToken("CampaignTransaction"), useValue: txs },
        { provide: getModelToken("AppSettings"), useValue: empty },
        { provide: PlansService, useValue: {} },
        { provide: PushService, useValue: push },
        { provide: NotificationsService, useValue: notifications },
        { provide: WhatsAppService, useValue: inertService() },
        { provide: ProfileVerificationService, useValue: inertService() },
        { provide: TrackingLinksService, useValue: inertService() },
        { provide: PlatformEventsService, useValue: inertService() },
      ],
    }).compile();
    service = module.get(CampaignInvitesService);
  }

  const working = (over: Record<string, any> = {}) => ({
    _id: INVITE,
    campaignId: CAMPAIGN,
    brandId: "host1",
    influencerId: "creator1",
    recipientRole: "influencer",
    status: "payment_confirmed",
    selectedPlatform: "Instagram",
    selectedPostDate: new Date(Date.now() - 5 * DAY),
    ...over,
  });

  describe("automatic closure without a post", () => {
    it("puts the host's payment on hold (not owed) and tells the host it is under review", async () => {
      await build([working()], [txRow({ payoutStatus: "pending" })]);
      await service.expireUnsubmittedInvite(INVITE, "Posting deadline passed.");
      const tx = txs.get("tx1");
      expect(tx.refundStatus).toBe("on_hold");
      expect(tx.payoutStatus).toBe("skipped");
      expect(invites.get(INVITE).financialCaseOpen).toBe(true);
      const hostNotice = notifications.createForUser.mock.calls
        .map((c) => c[0])
        .find((n) => n.userId === "host1");
      expect(hostNotice.title).toBe("Refund under review");
      expect(hostNotice.body).toContain("not yet approved");
      const creatorNotice = notifications.createForUser.mock.calls
        .map((c) => c[0])
        .find((n) => n.userId === "creator1");
      expect(creatorNotice.body).toContain("submit the link by");
    });

    it("an admin cancellation is an explicit approval → refund owed straight away", async () => {
      await build([working()], [txRow({ payoutStatus: "pending" })]);
      await service.expireUnsubmittedInvite(INVITE, "Cancelled by support.", {
        withdrawnReason: "admin_cancel",
        actor: { userId: "admin1", userRole: "admin" },
      });
      expect(txs.get("tx1")).toMatchObject({
        refundStatus: "owed",
        refundOwedBy: "admin1",
      });
    });
  });

  describe("late post", () => {
    const closed = () =>
      working({
        status: "withdrawn",
        withdrawnAt: new Date(Date.now() - DAY),
        withdrawnReason: "Posting deadline passed.",
      });
    const onHold = (over: Record<string, any> = {}) =>
      txRow({
        refundStatus: "on_hold",
        refundHoldUntil: new Date(Date.now() + 6 * DAY),
        ...over,
      });

    it("submitting only records the link — the money does not move", async () => {
      await build([closed()], [onHold()]);
      await service.submitLatePost(INVITE, "creator1", {
        postUrl: "https://www.instagram.com/reel/abc",
      });
      const tx = txs.get("tx1");
      expect(tx.latePost).toMatchObject({
        status: "pending",
        url: "https://www.instagram.com/reel/abc",
      });
      expect(tx.refundStatus).toBe("on_hold");
      expect(tx.payoutStatus).toBe("skipped");
      expect(invites.get(INVITE).status).toBe("withdrawn");
    });

    it("is refused for someone else's invite, a wrong platform, or after the hold", async () => {
      await build([closed()], [onHold()]);
      await expect(
        service.submitLatePost(INVITE, "other", {
          postUrl: "https://www.instagram.com/reel/abc",
        }),
      ).rejects.toThrow("Not your invite");
      await expect(
        service.submitLatePost(INVITE, "creator1", {
          postUrl: "https://youtube.com/shorts/x",
        }),
      ).rejects.toThrow("Instagram");
      await build(
        [closed()],
        [onHold({ refundHoldUntil: new Date(Date.now() - 1000) })],
      );
      await expect(
        service.submitLatePost(INVITE, "creator1", {
          postUrl: "https://www.instagram.com/reel/abc",
        }),
      ).rejects.toThrow("window has closed");
    });

    it("cannot be submitted twice while one is waiting", async () => {
      await build([closed()], [onHold()]);
      await service.submitLatePost(INVITE, "creator1", {
        postUrl: "https://www.instagram.com/reel/abc",
      });
      await expect(
        service.submitLatePost(INVITE, "creator1", {
          postUrl: "https://www.instagram.com/reel/def",
        }),
      ).rejects.toThrow("already waiting");
    });

    it("admin approval pays the creator, completes the invite and keeps the original closure on record", async () => {
      await build(
        [closed()],
        [
          onHold({
            latePost: {
              status: "pending",
              url: "https://www.instagram.com/reel/abc",
              submittedAt: new Date(),
              originalDeadline: new Date(Date.now() - 2 * DAY),
            },
          }),
        ],
      );
      const res = await service.adminReviewLatePost(INVITE, "admin1", {
        action: "approve",
        note: "Reel live, tags and date match brief",
      });
      expect(res).toMatchObject({
        decision: "approved",
        released: 1,
        settlement: 0,
      });
      const tx = txs.get("tx1");
      expect(tx).toMatchObject({
        refundStatus: "cancelled",
        payoutStatus: "processing",
      });
      expect(tx.latePost.status).toBe("approved");
      expect(tx.refundHistory.map((h: any) => h.action)).toEqual(
        expect.arrayContaining([
          "refund_cancelled_delivery_verified",
          "late_post_approved",
        ]),
      );
      const inv = invites.get(INVITE);
      expect(inv.status).toBe("completed");
      expect(inv.latePostApproval).toMatchObject({
        approvedBy: "admin1",
        withdrawnReason: "Posting deadline passed.",
      });
      expect(inv.latePostApproval.originalDeadline).toBeTruthy();
      expect(submissions.docs[0]).toMatchObject({
        status: "approved",
        isLate: true,
      });
    });

    it("approval after the refund was SENT opens a settlement — creator is not paid yet", async () => {
      await build(
        [closed()],
        [txRow({ refundStatus: "sent", refundAmount: 55000 })],
      );
      const res = await service.adminReviewLatePost(INVITE, "admin1", {
        action: "approve",
        note: "Found the reel on the creator's profile",
        postUrl: "https://www.instagram.com/reel/abc",
      });
      expect(res).toMatchObject({ released: 0, settlement: 1 });
      const tx = txs.get("tx1");
      expect(tx.payoutStatus).toBe("skipped");
      expect(tx.settlement).toMatchObject({
        status: "awaiting_host_repayment",
        amount: 55000,
      });
      const hostNotice = notifications.createForUser.mock.calls
        .map((c) => c[0])
        .find((n) => n.userId === "host1");
      expect(hostNotice.title).toBe("Repayment needed");
    });

    it("rejection keeps the hold and needs a reason", async () => {
      await build(
        [closed()],
        [
          onHold({
            latePost: {
              status: "pending",
              url: "https://www.instagram.com/reel/abc",
            },
          }),
        ],
      );
      await expect(
        service.adminReviewLatePost(INVITE, "admin1", {
          action: "reject",
          note: "no",
        }),
      ).rejects.toThrow("at least 10");
      await service.adminReviewLatePost(INVITE, "admin1", {
        action: "reject",
        note: "Post is from a different brand",
      });
      const tx = txs.get("tx1");
      expect(tx.latePost.status).toBe("rejected");
      expect(tx.refundStatus).toBe("on_hold");
      expect(invites.get(INVITE).status).toBe("withdrawn");
    });

    it("is blocked while an off-platform report is open", async () => {
      await build(
        [
          {
            ...closed(),
            reportedIssue: { reportedAt: new Date(), category: "offplatform" },
          },
        ],
        [
          onHold({
            latePost: {
              status: "pending",
              url: "https://www.instagram.com/reel/abc",
            },
          }),
        ],
      );
      await expect(
        service.adminReviewLatePost(INVITE, "admin1", {
          action: "approve",
          note: "Looks fine to me",
        }),
      ).rejects.toThrow("open report");
    });
  });

  describe("off-platform report", () => {
    it("either side can report; the other side is not notified", async () => {
      await build([working()]);
      await service.reportOffPlatform(
        INVITE,
        "creator1",
        "Host asked me to skip the post and take cash directly",
      );
      const inv = invites.get(INVITE);
      expect(inv.reportedIssue).toMatchObject({
        category: "offplatform",
        reportedByRole: "creator",
      });
      expect(inv.reportedIssue.reason).toContain(
        "Asked to skip posting / deal outside TrendStarZ",
      );
      expect(notifications.createForUser).not.toHaveBeenCalled();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it("needs details and a paid collaboration that is active or under refund review", async () => {
      await build([working()]);
      await expect(
        service.reportOffPlatform(INVITE, "creator1", "short"),
      ).rejects.toThrow("20 characters");
      await build([working({ status: "pending" })]);
      await expect(
        service.reportOffPlatform(
          INVITE,
          "creator1",
          "Host asked me to skip the post and take cash",
        ),
      ).rejects.toThrow("paid collaboration");
    });

    it("admin must write what was decided before resolving it", async () => {
      await build([
        working({
          reportedIssue: {
            reportedAt: new Date(),
            category: "offplatform",
            reason: "x",
          },
        }),
      ]);
      await expect(
        service.adminResolveDispute(INVITE, { outcome: "withdrawn" }, "admin1"),
      ).rejects.toThrow("Write what you checked");
      await expect(
        service.adminResolveDispute(INVITE, { outcome: "disputed" }, "admin1"),
      ).rejects.toThrow("Write what you checked");
    });
  });

  describe("terms acceptance", () => {
    it("records the creator's acceptance once with the terms version", async () => {
      await build([working()]);
      const res = await service.acceptPaidTerms(INVITE, "creator1");
      expect(res.termsAcceptance.creator).toMatchObject({
        userId: "creator1",
        version: expect.any(String),
      });
      const firstAt = invites.get(INVITE).termsAcceptance.creator.acceptedAt;
      await service.acceptPaidTerms(INVITE, "creator1");
      expect(invites.get(INVITE).termsAcceptance.creator.acceptedAt).toEqual(
        firstAt,
      );
    });
  });

  describe("campaign end", () => {
    it("a paid creator still inside their window blocks the host", async () => {
      await build([
        working({ selectedPostDate: new Date(Date.now() + 2 * DAY) }),
      ]);
      expect(await service.paidCreatorsStillPosting(CAMPAIGN)).toBe(true);
    });

    it("windows that have closed don't block", async () => {
      await build([
        working({ selectedPostDate: new Date(Date.now() - 30 * DAY) }),
      ]);
      expect(await service.paidCreatorsStillPosting(CAMPAIGN)).toBe(false);
    });
  });

  describe("contact visibility after close", () => {
    const done = (over: Record<string, any> = {}) => ({
      status: "completed",
      completedAt: new Date(Date.now() - 8 * DAY),
      ...over,
    });

    it("hides contacts 7 days after the collaboration completed", () => {
      expect(CampaignInvitesService.contactExpired(done())).toBe(true);
      expect(
        CampaignInvitesService.contactExpired(
          done({ completedAt: new Date(Date.now() - 2 * DAY) }),
        ),
      ).toBe(false);
    });

    it("keeps them while a report or a refund/settlement case is open", () => {
      expect(
        CampaignInvitesService.contactExpired(
          done({ reportedIssue: { reportedAt: new Date() } }),
        ),
      ).toBe(false);
      expect(
        CampaignInvitesService.contactExpired(
          done({ financialCaseOpen: true }),
        ),
      ).toBe(false);
    });
  });
});
