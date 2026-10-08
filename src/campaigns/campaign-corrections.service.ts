import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlatformEventsService } from "../platform-events/platform-events.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  MAX_ADMIN_EXTENSION_DAYS,
  campaignEndsAt,
  endOfIstDay,
  submissionWindow,
} from "./campaign-deadlines.util";
import { idIn } from "../utils/id-match.util";

/**
 * Admin campaign corrections — guided fixes a host asks support for, instead of
 * editing the database. Every action needs a reason, re-checks the invite's
 * current state on the server, is logged (invite.adminCorrections / the
 * campaign's adminOverride* fields) and notifies the creator.
 *
 * Money rule: nothing here moves money or touches a payout that was already
 * paid. A payment marked "refund to host" is only reset to pending when the
 * admin confirms the host was NOT refunded.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A restored creator gets the admin grace from now — or this, when the grace is 0/empty. */
const RESTORE_FALLBACK_HOURS = 24;
const DAY_MS = 24 * HOUR_MS;

/** Withdrawals an admin may undo: system expiry and admin cancellation. Not the host's or a dispute decision. */
const RESTORABLE_WITHDRAWALS = ["expired_unsubmitted", "admin_cancel"];
/** Statuses a restored invite may return to. */
const RESTORABLE_PREVIOUS = ["accepted", "payment_confirmed", "working"];
/** Accepted but not yet submitted. */
const OPEN_WORK = ["accepted", "payment_confirmed", "working"];
/** System withdrawal messages from before withdrawal events were recorded. */
const LEGACY_EXPIRY_MESSAGES = [
  "Posting deadline and grace period expired with no submission.",
  "Campaign's grace period ended with no submission.",
];

export interface ActionCheck {
  allowed: boolean;
  /** Why not (shown to the admin), when not allowed. */
  why?: string;
}

function ok(): ActionCheck {
  return { allowed: true };
}
function no(why: string): ActionCheck {
  return { allowed: false, why };
}

@Injectable()
export class CampaignCorrectionsService {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly transactionModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly invitesService: CampaignInvitesService,
    private readonly platformEvents: PlatformEventsService,
    private readonly pushService: PushService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /* ───────────────────────── helpers ───────────────────────── */

  private assertReason(reason: unknown): string {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length < 10) {
      throw new BadRequestException(
        "Please give a reason for this correction (at least 10 characters).",
      );
    }
    return trimmed;
  }

  private campaignFilterFor(campaignId: unknown) {
    const id = String(campaignId);
    return { $in: [campaignId, id] };
  }

  private async loadInvite(inviteId: string) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    return invite;
  }

  private async loadCampaign(campaignId: unknown) {
    const campaign = await this.campaignModel.findById(String(campaignId));
    if (!campaign) throw new NotFoundException("Campaign not found");
    return campaign;
  }

  private transactionsFor(invite: any) {
    return this.transactionModel.find({ inviteId: idIn(invite._id) }).lean();
  }

  /** Why and from what status this invite was withdrawn (event first, legacy message fallback). */
  private async withdrawalInfo(
    invite: any,
  ): Promise<{ reason: string | null; previousStatus: string | null }> {
    const event = await this.platformEvents.findInviteWithdrawn(invite._id);
    if (event?.metadata?.reason) {
      return {
        reason: String(event.metadata.reason),
        previousStatus: event.metadata.previousStatus
          ? String(event.metadata.previousStatus)
          : null,
      };
    }
    if (
      LEGACY_EXPIRY_MESSAGES.includes(String(invite?.withdrawnReason || ""))
    ) {
      return {
        reason: "expired_unsubmitted",
        previousStatus: invite?.paymentConfirmedAt
          ? "payment_confirmed"
          : "accepted",
      };
    }
    return { reason: null, previousStatus: null };
  }

  private recipientRole(invite: any): "influencer" | "photographer" {
    return String(invite?.recipientRole || "").toLowerCase() === "photographer"
      ? "photographer"
      : "influencer";
  }

  private notifyCreator(invite: any, title: string, body: string) {
    const userId = String(invite.influencerId);
    const url =
      this.recipientRole(invite) === "photographer"
        ? "/photographer-dashboard"
        : "/influencer-dashboard";
    this.pushService
      .sendToUser(userId, { title, body, url }, "campaign")
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId,
        userRole: this.recipientRole(invite),
        title,
        body,
        url,
      })
      .catch(() => {
        /* non-critical */
      });
  }

  /** Appends to the invite's admin log (never rewrites it — the field is not loaded by default). */
  private appendLog(inviteId: unknown, entry: Record<string, unknown>) {
    return this.inviteModel.updateOne(
      { _id: inviteId },
      { $push: { adminCorrections: entry } },
    );
  }

  private logEntry(
    action: string,
    reason: string,
    adminId: string,
    details?: any,
  ) {
    return {
      action,
      reason,
      by: adminId,
      at: new Date(),
      details: details ?? null,
    };
  }

  /* ───────────────────────── checks (pure-ish) ───────────────────────── */

  checkExtendEndDate(campaign: any): ActionCheck {
    const status = String(campaign?.status || "");
    if (status === "active") return ok();
    if (status === "completed") return ok(); // reopens it
    return no(
      `Only active or completed campaigns can be extended (this one is '${status}').`,
    );
  }

  async checkRestore(
    invite: any,
    campaign: any,
    txs: any[],
  ): Promise<ActionCheck> {
    if (invite.status !== "withdrawn")
      return no("Only withdrawn participation can be restored.");
    const { reason, previousStatus } = await this.withdrawalInfo(invite);
    if (!reason || !RESTORABLE_WITHDRAWALS.includes(reason)) {
      return no(
        reason
          ? `Withdrawn by '${reason}' — only automatic expiry or an admin cancellation can be undone here.`
          : "There is no record of why this was withdrawn.",
      );
    }
    if (!previousStatus || !RESTORABLE_PREVIOUS.includes(previousStatus)) {
      return no(
        "It was not accepted/paid before the withdrawal, so there is nothing to restore.",
      );
    }
    if (txs.some((t) => t.payoutStatus === "paid")) {
      return no("A payout for this collaboration was already paid.");
    }
    if (String(campaign?.status || "") !== "active") {
      return no(
        "The campaign is not active — extend/reopen its end date first.",
      );
    }
    return ok();
  }

  checkExtendDeadline(invite: any, campaign: any): ActionCheck {
    if (!OPEN_WORK.includes(invite.status)) {
      return no(
        "Only accepted work that has not been submitted can be extended.",
      );
    }
    if (!invite.selectedPostDate) {
      return no("No post date chosen yet, so no submission deadline applies.");
    }
    if (String(campaign?.status || "") !== "active") {
      return no(
        "The campaign is not active — extend/reopen its end date first.",
      );
    }
    return ok();
  }

  checkSubmitOnBehalf(invite: any, campaign: any, graceHours = 0): ActionCheck {
    if (!OPEN_WORK.includes(invite.status)) {
      return no("Only accepted work that has not been submitted yet.");
    }
    if (!invite.paymentConfirmedAt && invite.status === "accepted") {
      return no("Payment for this collaboration is not confirmed yet.");
    }
    if (String(campaign?.status || "") !== "active") {
      return no(
        "The campaign is not active — extend/reopen its end date first.",
      );
    }
    const window = submissionWindow(
      invite,
      campaign?.postingDeadlineMode,
      graceHours,
    );
    if (window && Date.now() > window.closesAt.getTime()) {
      return no(
        "The submission window has closed — extend the deadline first.",
      );
    }
    return ok();
  }

  checkCancel(invite: any, txs: any[]): ActionCheck {
    if (!OPEN_WORK.includes(invite.status)) {
      return no(
        "Only accepted work that has not been submitted can be cancelled here.",
      );
    }
    if (invite.reportedIssue?.reportedAt && !invite.reportedIssue?.resolvedAt) {
      return no(
        "There is an open host report — resolve it on the Disputes page.",
      );
    }
    if (txs.some((t) => t.payoutStatus === "paid")) {
      return no("A payout for this collaboration was already paid.");
    }
    return ok();
  }

  /* ───────────────────────── read ───────────────────────── */

  async getCorrections(campaignId: string) {
    const campaign: any = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    const graceHours = await this.invitesService.getPaidSubmitGraceHours();

    const invites: any[] = await this.inviteModel
      .find({
        campaignId: this.campaignFilterFor(campaign._id),
        status: {
          $in: [
            ...OPEN_WORK,
            "withdrawn",
            "submitted",
            "approved",
            "completed",
            "disputed",
          ],
        },
      })
      .select("+adminCorrections")
      .sort({ createdAt: 1 })
      .lean();

    const inviteIds = invites.flatMap((i) => [i._id, String(i._id)]);
    const txs: any[] = inviteIds.length
      ? await this.transactionModel
          .find({ inviteId: { $in: inviteIds } })
          .lean()
      : [];
    const txByInvite = new Map<string, any[]>();
    for (const t of txs) {
      const k = String(t.inviteId);
      txByInvite.set(k, [...(txByInvite.get(k) || []), t]);
    }

    const creatorIds = invites.map((i) => String(i.influencerId));
    const [influencers, photographers] = await Promise.all([
      this.influencerModel
        .find({ _id: { $in: creatorIds } })
        .select("name username")
        .lean(),
      this.photographerModel
        .find({ _id: { $in: creatorIds } })
        .select("name username")
        .lean(),
    ]);
    const names = new Map<string, string>();
    for (const p of [...(influencers as any[]), ...(photographers as any[])]) {
      names.set(String(p._id), p.name || p.username || "");
    }

    const rows = [];
    for (const invite of invites) {
      const itxs = txByInvite.get(String(invite._id)) || [];
      const tx = itxs[0] || null;
      const window = submissionWindow(
        invite,
        campaign.postingDeadlineMode,
        graceHours,
      );
      const withdrawal =
        invite.status === "withdrawn"
          ? await this.withdrawalInfo(invite)
          : null;
      rows.push({
        inviteId: String(invite._id),
        creatorId: String(invite.influencerId),
        creatorName: names.get(String(invite.influencerId)) || "Creator",
        recipientRole: this.recipientRole(invite),
        status: invite.status,
        selectedPostDate: invite.selectedPostDate ?? null,
        paymentConfirmedAt: invite.paymentConfirmedAt ?? null,
        submissionClosesAt: window?.closesAt ?? null,
        submissionDeadlineExtendedTo:
          invite.submissionDeadlineExtendedTo ?? null,
        withdrawnAt: invite.withdrawnAt ?? null,
        withdrawal,
        payment: tx
          ? {
              amountPaise: Number(tx.recipientPayout || tx.agreedAmount || 0),
              collectionStatus: tx.collectionStatus ?? null,
              payoutStatus: tx.payoutStatus ?? null,
              resolveOutcome: tx.resolveOutcome ?? null,
            }
          : null,
        corrections: invite.adminCorrections || [],
        actions: {
          restore: await this.checkRestore(invite, campaign, itxs),
          extendDeadline: this.checkExtendDeadline(invite, campaign),
          submitOnBehalf: this.checkSubmitOnBehalf(
            invite,
            campaign,
            graceHours,
          ),
          cancel: this.checkCancel(invite, itxs),
        },
      });
    }

    return {
      campaign: {
        id: String(campaign._id),
        campaignNumber: campaign.campaignNumber ?? null,
        title: campaign.title || "",
        status: campaign.status,
        endDate: campaign.endDate ?? null,
        timelineEnd: campaign.timelineEnd ?? null,
        endsAt: campaignEndsAt(campaign),
        completedBy: campaign.completedBy ?? null,
        completedAt: campaign.completedAt ?? null,
        adminOverrideAction: campaign.adminOverrideAction ?? null,
        adminOverrideReason: campaign.adminOverrideReason ?? "",
        adminOverrideAt: campaign.adminOverrideAt ?? null,
      },
      actions: { extendEndDate: this.checkExtendEndDate(campaign) },
      rules: {
        graceHours,
        maxExtensionDays: MAX_ADMIN_EXTENSION_DAYS,
      },
      invites: rows,
    };
  }

  /* ───────────────────────── actions ───────────────────────── */

  /** Moves the end date later; a completed campaign is reopened. Date is YYYY-MM-DD (India date). */
  async extendEndDate(
    campaignId: string,
    body: { endDate?: string; reason?: string },
    adminId: string,
  ) {
    const reason = this.assertReason(body?.reason);
    const campaign = await this.loadCampaign(campaignId);
    const check = this.checkExtendEndDate(campaign);
    if (!check.allowed) throw new BadRequestException(check.why);

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      String(body?.endDate || "").trim(),
    );
    if (!m) throw new BadRequestException("End date must be YYYY-MM-DD.");
    const newEnd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (Number.isNaN(newEnd.getTime()))
      throw new BadRequestException("Invalid end date.");

    if (endOfIstDay(newEnd).getTime() <= Date.now()) {
      throw new BadRequestException("The new end date must be today or later.");
    }
    const currentEnds = campaignEndsAt(campaign);
    if (currentEnds && endOfIstDay(newEnd).getTime() <= currentEnds.getTime()) {
      throw new BadRequestException(
        "The new end date must be later than the current one.",
      );
    }
    const start = campaign.timelineStart || campaign.startDate;
    if (start && newEnd.getTime() < new Date(start).getTime()) {
      throw new BadRequestException(
        "The end date can't be before the start date.",
      );
    }

    const reopened = campaign.status === "completed";
    const previousEnd = campaign.endDate || campaign.timelineEnd || null;
    campaign.endDate = newEnd;
    campaign.timelineEnd = newEnd;
    if (reopened) {
      campaign.status = "active";
      campaign.completedAt = null;
      campaign.completedBy = null;
    }
    campaign.adminOverrideAction = "extend_end_date";
    campaign.adminOverrideReason = reason;
    campaign.adminOverrideBy = adminId;
    campaign.adminOverrideAt = new Date();
    await campaign.save();

    return {
      success: true,
      reopened,
      previousEnd,
      endDate: newEnd,
      endsAt: endOfIstDay(newEnd),
    };
  }

  /** Undoes an automatic expiry / admin cancellation: back to the status before the withdrawal. */
  async restoreParticipation(
    inviteId: string,
    body: { reason?: string; hostNotRefunded?: boolean },
    adminId: string,
  ) {
    const reason = this.assertReason(body?.reason);
    const invite = await this.loadInvite(inviteId);
    const campaign = await this.loadCampaign(invite.campaignId);
    const txs: any[] = await this.transactionsFor(invite);
    const check = await this.checkRestore(invite, campaign, txs);
    if (!check.allowed) throw new BadRequestException(check.why);

    const refundMarked = txs.some(
      (t) =>
        t.payoutStatus === "skipped" || t.resolveOutcome === "refund_to_brand",
    );
    if (refundMarked && body?.hostNotRefunded !== true) {
      throw new BadRequestException(
        "This payment is marked 'refund to host'. Confirm the host has NOT been refunded before restoring.",
      );
    }

    const { previousStatus, reason: withdrawnBy } =
      await this.withdrawalInfo(invite);
    const now = new Date();
    invite.status = previousStatus;
    invite.withdrawnAt = undefined;
    invite.withdrawnReason = undefined;
    invite.updatedAt = now;

    // A restored creator always gets a real window to submit.
    let extendedTo: Date | null = null;
    if (invite.selectedPostDate) {
      const graceHours = await this.invitesService.getPaidSubmitGraceHours();
      const window = submissionWindow(
        invite,
        campaign.postingDeadlineMode,
        graceHours,
      );
      const minimum = new Date(
        now.getTime() + (graceHours || RESTORE_FALLBACK_HOURS) * HOUR_MS,
      );
      if (!window || window.closesAt.getTime() < minimum.getTime()) {
        invite.submissionDeadlineExtendedTo = minimum;
        extendedTo = minimum;
      }
    }
    await invite.save();
    await this.appendLog(
      invite._id,
      this.logEntry("restore_participation", reason, adminId, {
        restoredTo: previousStatus,
        withdrawnBy,
        submissionDeadlineExtendedTo: extendedTo,
      }),
    );

    const txReset = await this.transactionModel.updateMany(
      {
        inviteId: idIn(invite._id),
        payoutStatus: { $ne: "paid" },
        $or: [
          { payoutStatus: "skipped" },
          { resolveOutcome: "refund_to_brand" },
        ],
      },
      {
        $set: {
          payoutStatus: "pending",
          workStatus: "pending",
          disputeStatus: "none",
        },
        $unset: { resolveOutcome: "", resolvedAt: "" },
      },
    );

    this.notifyCreator(
      invite,
      "Participation Restored",
      `Your participation in "${campaign.title || "this campaign"}" has been restored.${
        extendedTo
          ? ` You can submit your post until ${extendedTo.toUTCString()}.`
          : ""
      }`,
    );

    return {
      success: true,
      status: invite.status,
      submissionDeadlineExtendedTo: extendedTo,
      paymentsReset: txReset.modifiedCount ?? 0,
    };
  }

  /** Gives one creator until `until` (ISO) to submit — at most MAX_ADMIN_EXTENSION_DAYS from now. */
  async extendSubmissionDeadline(
    inviteId: string,
    body: { until?: string; reason?: string },
    adminId: string,
  ) {
    const reason = this.assertReason(body?.reason);
    const invite = await this.loadInvite(inviteId);
    const campaign = await this.loadCampaign(invite.campaignId);
    const check = this.checkExtendDeadline(invite, campaign);
    if (!check.allowed) throw new BadRequestException(check.why);

    const until = new Date(String(body?.until || ""));
    if (Number.isNaN(until.getTime()))
      throw new BadRequestException("Invalid new deadline.");
    const now = Date.now();
    if (until.getTime() <= now)
      throw new BadRequestException("The new deadline must be in the future.");
    if (until.getTime() > now + MAX_ADMIN_EXTENSION_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A deadline can be extended by at most ${MAX_ADMIN_EXTENSION_DAYS} days from now.`,
      );
    }
    const current = submissionWindow(
      invite,
      campaign.postingDeadlineMode,
      await this.invitesService.getPaidSubmitGraceHours(),
    );
    if (current && until.getTime() <= current.closesAt.getTime()) {
      throw new BadRequestException(
        `The new deadline must be later than the current one (${current.closesAt.toISOString()}).`,
      );
    }

    invite.submissionDeadlineExtendedTo = until;
    invite.updatedAt = new Date();
    await invite.save();
    await this.appendLog(
      invite._id,
      this.logEntry("extend_submission_deadline", reason, adminId, {
        from: current?.closesAt ?? null,
        to: until,
      }),
    );

    this.notifyCreator(
      invite,
      "Submission Deadline Extended",
      `You can now submit your post for "${campaign.title || "this campaign"}" until ${until.toUTCString()}.`,
    );
    return { success: true, submissionClosesAt: until };
  }

  /** Records the post link the host confirmed, through the normal submit flow (host review → payout). */
  async submitOnBehalf(
    inviteId: string,
    body: { postUrl?: string; reason?: string },
    adminId: string,
  ) {
    const reason = this.assertReason(body?.reason);
    const postUrl = String(body?.postUrl || "").trim();
    if (!/^https?:\/\/\S+$/i.test(postUrl)) {
      throw new BadRequestException("Enter the full post link (https://…).");
    }
    const invite = await this.loadInvite(inviteId);
    const campaign = await this.loadCampaign(invite.campaignId);
    const check = this.checkSubmitOnBehalf(
      invite,
      campaign,
      await this.invitesService.getPaidSubmitGraceHours(),
    );
    if (!check.allowed) throw new BadRequestException(check.why);

    const result = await this.invitesService.submitPost(
      String(invite._id),
      String(invite.influencerId),
      { postUrl },
    );

    await this.appendLog(
      invite._id,
      this.logEntry("submit_on_behalf", reason, adminId, { postUrl }),
    );
    this.notifyCreator(
      invite,
      "Post Submitted for You",
      `TrendStarZ support submitted your post link for "${campaign.title || "this campaign"}". It's now with the host for review.`,
    );
    return { success: true, result };
  }

  /** Ends one creator's unsubmitted participation; the payment is marked "refund to host". */
  async cancelParticipation(
    inviteId: string,
    body: { reason?: string },
    adminId: string,
  ) {
    const reason = this.assertReason(body?.reason);
    const invite = await this.loadInvite(inviteId);
    const txs: any[] = await this.transactionsFor(invite);
    const check = this.checkCancel(invite, txs);
    if (!check.allowed) throw new BadRequestException(check.why);

    const result: any = await this.invitesService.expireUnsubmittedInvite(
      String(invite._id),
      "This collaboration was cancelled by TrendStarZ support.",
      {
        withdrawnReason: "admin_cancel",
        actor: { userId: adminId, userRole: "admin" },
      },
    );
    if (result?.skipped) {
      throw new BadRequestException(
        `Nothing changed — the invite is now '${result?.status ?? "unknown"}'. Reload and try again.`,
      );
    }
    await this.appendLog(
      invite._id,
      this.logEntry("cancel_participation", reason, adminId),
    );
    return { success: true, status: "withdrawn" };
  }
}
