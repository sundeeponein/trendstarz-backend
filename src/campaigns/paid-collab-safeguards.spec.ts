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
  let credits: FakeCollection;
  let settings: FakeCollection;
  let notifications: { createForUser: jest.Mock };

  async function build(
    inviteRows: any[],
    txRows: any[] = [],
    appSettings: any[] = [],
    creditRows: any[] = [],
    campaignOver: Record<string, any> = {},
  ) {
    invites = new InviteCollection(inviteRows);
    credits = new FakeCollection(creditRows);
    settings = new FakeCollection(appSettings);
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
            { _id: CAMPAIGN, title: "Diwali Reels", status: "active", ...campaignOver },
          ]),
        },
        {
          provide: getModelToken("Brand"),
          useValue: new FakeCollection([{ _id: "host1", brandName: "Acme" }]),
        },
        { provide: getModelToken("Photographer"), useValue: empty },
        { provide: getModelToken("Influencer"), useValue: empty },
        { provide: getModelToken("CampaignTransaction"), useValue: txs },
        { provide: getModelToken("AppSettings"), useValue: settings },
        { provide: getModelToken("PlatformCredit"), useValue: credits },
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
      expect(await service.creatorsStillPosting(CAMPAIGN)).toBe(true);
    });

    it("a barter/location creator who accepted (host confirmed) also blocks the host", async () => {
      await build(
        [working({ status: "accepted", platformFeeDue: 5000, platformFeePaidAt: new Date(), selectedPostDate: new Date(Date.now() + DAY) })],
        [], [], [], { campaignType: "invite_location" },
      );
      expect(await service.creatorsStillPosting(CAMPAIGN)).toBe(true);
    });

    it("doesn't block when the creator couldn't start yet (paid collab unpaid, platform fee unpaid)", async () => {
      await build(
        [working({ status: "accepted", selectedPostDate: new Date(Date.now() + DAY) })],
        [], [], [], { campaignType: "paid_collab" },
      );
      expect(await service.creatorsStillPosting(CAMPAIGN)).toBe(false);
      await build(
        [working({ status: "accepted", platformFeeDue: 5000, platformFeePaidAt: null, selectedPostDate: new Date(Date.now() + DAY) })],
        [], [], [], { campaignType: "invite_location" },
      );
      expect(await service.creatorsStillPosting(CAMPAIGN)).toBe(false);
    });

    it("an unpaid paid-collab creator closed by the host's end isn't a no-show (slot freed)", async () => {
      await build(
        [working({ status: "accepted", paymentConfirmedAt: null })],
        [], [], [], { campaignType: "paid_collab" },
      );
      await service.expireUnsubmittedInvitesForCampaign(CAMPAIGN, "Campaign ended by host before submission.");
      expect(invites.get(INVITE)).toMatchObject({ status: "withdrawn", withdrawnReasonCode: "host_ended_unpaid" });
    });

    it("windows that have closed don't block", async () => {
      await build([
        working({ selectedPostDate: new Date(Date.now() - 30 * DAY) }),
      ]);
      expect(await service.creatorsStillPosting(CAMPAIGN)).toBe(false);
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

  describe("paid invite slot (terms v2)", () => {
    const from = new Date(Date.now() - 10 * DAY);
    const rows = [
      { _id: "a", campaignId: CAMPAIGN, status: "payment_confirmed" },
      {
        _id: "b",
        campaignId: CAMPAIGN,
        status: "withdrawn",
        paymentConfirmedAt: new Date(Date.now() - DAY),
      },
      { _id: "c", campaignId: CAMPAIGN, status: "withdrawn" }, // before payment
      { _id: "d", campaignId: CAMPAIGN, status: "declined" },
      {
        _id: "e",
        campaignId: CAMPAIGN,
        status: "withdrawn",
        paymentConfirmedAt: new Date(Date.now() - 20 * DAY),
      }, // paid before v2
      {
        _id: "f",
        campaignId: CAMPAIGN,
        status: "withdrawn",
        paymentConfirmedAt: new Date(Date.now() - DAY),
        slotRestored: {
          at: new Date(),
          by: "admin1",
          reason: "platform error",
        },
      },
    ];
    const count = async () =>
      invites.countDocuments(
        await (service as any).consumingInviteFilter(CAMPAIGN),
      );

    it("before the effective date a closed paid invite frees its slot (unchanged)", async () => {
      await build(rows);
      expect(await count()).toBe(1);
    });

    it("after it, a paid invite that closed stays counted; declined, unpaid and restored ones don't", async () => {
      await build(rows, [], [{ paidCollabTermsV2EffectiveAt: from }]);
      expect(await count()).toBe(2); // a + b
    });

    it("admin can restore a paid slot only with a reason", async () => {
      await build(rows, [], [{ paidCollabTermsV2EffectiveAt: from }]);
      await expect(
        service.adminRestoreSlot("b", "admin1", "x"),
      ).rejects.toThrow("at least 10");
      await service.adminRestoreSlot("b", "admin1", "Creator account was fake");
      expect(await count()).toBe(1);
      await expect(
        service.adminRestoreSlot("c", "admin1", "Creator account was fake"),
      ).rejects.toThrow("Only a paid invite");
    });
  });

  describe("private closure answers", () => {
    const closed = (over: Record<string, any> = {}) =>
      working({ status: "withdrawn", withdrawnAt: new Date(), ...over });
    const held = (over: Record<string, any> = {}) =>
      txRow({ refundStatus: "on_hold", noPostClosure: true, ...over });

    it("an off-platform answer opens a report (refund held); the host never sees it", async () => {
      await build([closed()], [held()]);
      await service.submitClosureAnswer(INVITE, "creator1", {
        answer: "host_offered_outside",
        details: "Host said pay me on WhatsApp instead",
      });
      const inv = invites.get(INVITE);
      expect(inv.closureAnswers.creator.answer).toBe("host_offered_outside");
      expect(inv.reportedIssue).toMatchObject({
        category: "offplatform",
        reportedByRole: "creator",
      });
      const hostView = CampaignInvitesService.forParty(inv, "host");
      expect(hostView.closureAnswers).toBeUndefined();
      expect(hostView.reportedIssue).toBeUndefined();
      expect(
        CampaignInvitesService.forParty(inv, "creator").closureAnswers.creator
          .answer,
      ).toBe("host_offered_outside");
    });

    it("each side answers once; a 'saw the post' answer needs the link", async () => {
      await build([closed()], [held()]);
      await expect(
        service.submitClosureAnswer(INVITE, "host1", { answer: "saw_post" }),
      ).rejects.toThrow("Paste the link");
      await service.submitClosureAnswer(INVITE, "host1", {
        answer: "saw_post",
        link: "https://www.instagram.com/reel/x",
      });
      await expect(
        service.submitClosureAnswer(INVITE, "host1", { answer: "no_post" }),
      ).rejects.toThrow("already answered");
      expect(invites.get(INVITE).reportedIssue).toBeUndefined(); // not an off-platform answer
    });

    it("closed once the refund was sent", async () => {
      await build([closed()], [held({ refundStatus: "sent" })]);
      await expect(
        service.submitClosureAnswer(INVITE, "creator1", { answer: "forgot" }),
      ).rejects.toThrow("only open while");
    });
  });

  describe("cancel / pause requests", () => {
    const paidTx = (over: Record<string, any> = {}) =>
      txRow({
        payoutStatus: "pending",
        agreedAmount: 50000,
        platformFee: 5000,
        ...over,
      });

    it("needs a confirmed payment and a reason; a pending request stops the automatic closure", async () => {
      await build(
        [working()],
        [paidTx({ collectionStatus: "proof_submitted" })],
      );
      await expect(
        service.requestCancelOrPause(INVITE, "host1", {
          type: "cancel",
          reason: "Brand changed the launch plan",
        }),
      ).rejects.toThrow("Payment is not confirmed");
      await build([working()], [paidTx()]);
      await expect(
        service.requestCancelOrPause(INVITE, "host1", {
          type: "cancel",
          reason: "no",
        }),
      ).rejects.toThrow("15 characters");
      await service.requestCancelOrPause(INVITE, "host1", {
        type: "cancel",
        reason: "Brand changed the launch plan",
      });
      const res: any = await service.expireUnsubmittedInvite(
        INVITE,
        "Posting deadline passed.",
      );
      expect(res.skipped).toBe(true);
      expect(invites.get(INVITE).status).toBe("payment_confirmed");
      // The creator sees that a request exists, not the host's text.
      const creatorView = CampaignInvitesService.forParty(
        invites.get(INVITE),
        "creator",
      );
      expect(creatorView.cancelRequest).toEqual({
        type: "cancel",
        status: "pending",
        requestedByRole: "host",
      });
    });

    it("approved cancel with compensation: creator paid part, host refunded the rest, not held against the creator", async () => {
      await build([working()], [paidTx()]);
      await service.requestCancelOrPause(INVITE, "host1", {
        type: "cancel",
        reason: "Brand changed the launch plan",
      });
      await expect(
        service.adminDecideCancelRequest(INVITE, "admin1", {
          decision: "approve",
          note: "Creator had drafted the reel",
          compensation: 60000,
        }),
      ).rejects.toThrow("can't be more than the agreed amount");
      await service.adminDecideCancelRequest(INVITE, "admin1", {
        decision: "approve",
        note: "Creator had drafted the reel",
        compensation: 20000,
      });
      const tx = txs.get("tx1");
      expect(tx).toMatchObject({
        refundStatus: "owed",
        payoutStatus: "processing",
        recipientPayout: 20000,
      });
      expect(tx.compensation.amount).toBe(20000);
      expect(tx.noPostClosure).toBeUndefined();
      const inv = invites.get(INVITE);
      expect(inv.status).toBe("withdrawn");
      expect(inv.cancelRequest.status).toBe("approved");
      expect(inv.missExcused.reason).toContain("host");
      await expect(
        service.adminDecideCancelRequest(INVITE, "admin1", {
          decision: "reject",
          note: "Changed my mind here",
        }),
      ).rejects.toThrow("no pending request");
    });

    it("approved pause moves the deadline; reject changes nothing", async () => {
      await build(
        [working({ selectedPostDate: new Date(Date.now() + DAY) })],
        [paidTx()],
      );
      await service.requestCancelOrPause(INVITE, "creator1", {
        type: "pause",
        reason: "I am unwell this week, need time",
      });
      await expect(
        service.adminDecideCancelRequest(INVITE, "admin1", {
          decision: "approve",
          note: "Medical reason accepted",
          pauseDays: 30,
        }),
      ).rejects.toThrow("1 to 14 days");
      const res: any = await service.adminDecideCancelRequest(
        INVITE,
        "admin1",
        {
          decision: "approve",
          note: "Medical reason accepted",
          pauseDays: 5,
        },
      );
      expect(
        new Date(res.submissionDeadlineExtendedTo).getTime(),
      ).toBeGreaterThan(Date.now() + 5 * DAY);
      expect(invites.get(INVITE).status).toBe("payment_confirmed");
    });
  });

  describe("creator completion record (display only)", () => {
    it("counts delivered work and system no-post closures, skipping excused, reported and later-verified ones", async () => {
      await build(
        [
          { _id: "64b000000000000000000101", status: "withdrawn" },
          {
            _id: "64b000000000000000000102",
            status: "withdrawn",
            missExcused: { at: new Date() },
          },
          {
            _id: "64b000000000000000000103",
            status: "withdrawn",
            reportedIssue: { reportedAt: new Date() },
          },
          { _id: "64b000000000000000000104", status: "completed" }, // late post verified
        ],
        [
          txRow({
            _id: "c1",
            recipientId: "creator1",
            workStatus: "approved",
            payoutStatus: "paid",
          }),
          txRow({
            _id: "c2",
            recipientId: "creator1",
            workStatus: "approved",
            payoutStatus: "processing",
          }),
          txRow({
            _id: "m1",
            inviteId: "64b000000000000000000101",
            noPostClosure: true,
            refundStatus: "owed",
          }),
          txRow({
            _id: "m2",
            inviteId: "64b000000000000000000102",
            noPostClosure: true,
            refundStatus: "sent",
          }),
          txRow({
            _id: "m3",
            inviteId: "64b000000000000000000103",
            noPostClosure: true,
            refundStatus: "on_hold",
          }),
          txRow({
            _id: "m4",
            inviteId: "64b000000000000000000104",
            noPostClosure: true,
            refundStatus: "cancelled",
            workStatus: "approved",
          }),
        ],
      );
      expect(await service.creatorCompletionRecord("creator1")).toEqual({
        completed: 3,
        missed: 1,
      });
    });

    it("admin excuse needs a reason", async () => {
      await build([{ _id: "64b000000000000000000101", status: "withdrawn" }]);
      await expect(
        service.adminExcuseMiss("64b000000000000000000101", "admin1", "x"),
      ).rejects.toThrow("at least 10");
      await service.adminExcuseMiss(
        "64b000000000000000000101",
        "admin1",
        "Host told the creator not to post",
      );
      expect(invites.get("64b000000000000000000101").missExcused.reason).toBe(
        "Host told the creator not to post",
      );
    });
  });

  describe("online-post contact rule", () => {
    it("paid_collab hides phone/email; product, location and event campaigns keep them", () => {
      expect(
        CampaignInvitesService.contactSharedForCampaignType("paid_collab"),
      ).toBe(false);
      for (const t of ["product", "invite_location", "event_coverage"]) {
        expect(CampaignInvitesService.contactSharedForCampaignType(t)).toBe(
          true,
        );
      }
    });
  });

  describe("product shipping (barter)", () => {
    const product = { campaignType: "product", productShippingRequired: true };

    it("only an accepted, unsubmitted collaboration can be marked shipped", async () => {
      await build([working({ status: "pending" })], [], [], [], product);
      await expect(
        service.updateProductFulfillment(INVITE, "host1", { trackingId: "AWB1" }),
      ).rejects.toThrow("accepted collaboration");
    });

    it("refuses invalid and future dates, and delivery before shipping", async () => {
      await build([working({ status: "accepted" })], [], [], [], product);
      await expect(
        service.updateProductFulfillment(INVITE, "host1", { shippedAt: "not a date" }),
      ).rejects.toThrow("isn't a valid date");
      await expect(
        service.updateProductFulfillment(INVITE, "host1", {
          deliveredAt: new Date(Date.now() + 3 * DAY).toISOString(),
        }),
      ).rejects.toThrow("can't be in the future");
      await expect(
        service.updateProductFulfillment(INVITE, "host1", {
          shippedAt: new Date(Date.now() - 1 * DAY).toISOString(),
          deliveredAt: new Date(Date.now() - 2 * DAY).toISOString(),
        }),
      ).rejects.toThrow("before the shipped date");
    });

    it("'delivered' records the delivery time and can't be undone (only 'returned')", async () => {
      await build([working({ status: "accepted" })], [], [], [], product);
      await service.updateProductFulfillment(INVITE, "host1", { status: "delivered" });
      const deliveredAt = new Date(invites.get(INVITE).productFulfillment.deliveredAt);
      expect(Math.abs(deliveredAt.getTime() - Date.now())).toBeLessThan(60 * 1000);
      await expect(
        service.updateProductFulfillment(INVITE, "host1", { status: "pending" }),
      ).rejects.toThrow("already marked delivered");
      await service.updateProductFulfillment(INVITE, "host1", { status: "returned" });
      expect(invites.get(INVITE).productFulfillment.status).toBe("returned");
    });
  });

  describe("settlement takes back fee credit", () => {
    it("unused credit is reversed and spent credit is added to what the host repays", async () => {
      await build(
        [working({ status: "withdrawn", withdrawnAt: new Date() })],
        [
          txRow({
            refundStatus: "sent",
            refundAmount: 50000,
            refundPolicy: "fee_credit",
            platformFee: 5000,
            feeCredit: { status: "issued", amount: 5000 },
          }),
        ],
        [],
        [
          {
            _id: "lot",
            ownerId: "host1",
            type: "issued",
            amount: 5000,
            remaining: 3000,
            transactionId: "tx1",
            expiresAt: new Date(Date.now() + 300 * DAY),
          },
          // ₹20 of it was spent on a later payment (consumeCredit writes this record).
          { _id: "use1", ownerId: "host1", type: "used", amount: 2000, lotId: "lot", transactionId: "tx9", restoredAt: null },
        ],
      );
      await service.adminReviewLatePost(INVITE, "admin1", {
        action: "approve",
        note: "Found the reel on the profile",
        postUrl: "https://www.instagram.com/reel/abc",
      });
      const tx = txs.get("tx1");
      expect(tx.settlement).toMatchObject({
        status: "awaiting_host_repayment",
        amount: 50000 + 2000,
      });
      expect(tx.feeCredit.status).toBe("reversed");
      expect(credits.get("lot").remaining).toBe(0);
    });

    it("a second, overlapping verification doesn't charge the host again", async () => {
      await build(
        [working({ status: "withdrawn", withdrawnAt: new Date() })],
        [
          txRow({
            refundStatus: "sent",
            refundAmount: 50000,
            refundPolicy: "fee_credit",
            platformFee: 5000,
            feeCredit: { status: "issued", amount: 5000 },
          }),
        ],
        [],
        [
          {
            _id: "lot",
            ownerId: "host1",
            type: "issued",
            amount: 5000,
            remaining: 5000,
            transactionId: "tx1",
            expiresAt: new Date(Date.now() + 300 * DAY),
          },
        ],
      );
      const settlementRow = () => [{ ...txs.get("tx1"), _id: "tx1" }];
      // Two runs of the same step (e.g. a retry): the second finds the credit claimed.
      await (service as any).afterDeliveryVerified({ _id: INVITE }, { released: [], settlement: settlementRow() });
      await (service as any).afterDeliveryVerified({ _id: INVITE }, { released: [], settlement: settlementRow() });
      expect(Number(txs.get("tx1").settlement?.amount || 0)).toBe(0); // nothing was spent
      expect(credits.get("lot").remaining).toBe(0);
    });
  });
});
