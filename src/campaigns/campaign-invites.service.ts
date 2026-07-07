import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import { inviteReminderTemplate } from "../email/templates/campaign.templates";
import { PlansService } from "../plans/plans.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";
import { TrackingLinksService } from "./tracking-links.service";

function detectPlatform(url: string): string {
  if (!url) return "other";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/facebook\.com/i.test(url)) return "facebook";
  return "other";
}

function computeEngagementRate(data: any): number {
  const reach = data.reachCount || data.viewsCount || 0;
  if (!reach) return 0;
  const interactions =
    (data.likesCount || 0) +
    (data.commentsCount || 0) +
    (data.sharesCount || 0);
  return Math.round((interactions / reach) * 10000) / 100; // percentage with 2 decimal places
}

@Injectable()
export class CampaignInvitesService {
  private readonly logger = new Logger(CampaignInvitesService.name);
  /** TTL cache for attention-count endpoints. Key → {value, expiresAt}. */
  private readonly attentionCache = new Map<
    string,
    { value: any; expiresAt: number }
  >();
  private readonly ATTENTION_CACHE_TTL_MS = 60 * 1000;

  private getCachedAttention<T>(key: string): T | null {
    const hit = this.attentionCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.attentionCache.delete(key);
      return null;
    }
    return hit.value as T;
  }

  private setCachedAttention(key: string, value: any) {
    this.attentionCache.set(key, {
      value,
      expiresAt: Date.now() + this.ATTENTION_CACHE_TTL_MS,
    });
  }

  /** Invalidate all cached attention counts (call on writes that affect them). */
  private invalidateAttentionCache() {
    this.attentionCache.clear();
  }

  /** Matches "has an unresolved brand-reported issue" — covers both a plain report and a
   *  genuine submission-dispute (both mirror onto reportedIssue the same way). */
  private openReportFilter(): Record<string, any> {
    return {
      "reportedIssue.reportedAt": { $ne: null },
      "reportedIssue.resolvedAt": { $in: [null, undefined] },
    };
  }

  constructor(
    @InjectModel("CampaignInvite")
    private readonly inviteModel: Model<any>,
    @InjectModel("CampaignSubmission")
    private readonly submissionModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly campaignTransactionModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    private readonly plansService: PlansService,
    private readonly pushService: PushService,
    private readonly notificationsService: NotificationsService,
    private readonly profileVerificationService: ProfileVerificationService,
    private readonly trackingLinksService: TrackingLinksService,
  ) {}

  private async getSubmissionApprovalWaitHours(): Promise<number> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    const hours = Number(settings?.submissionApprovalWaitHours ?? 24);
    return Number.isFinite(hours) && hours >= 0 ? hours : 24;
  }

  private async getDisputeResponseWaitHours(): Promise<number> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    const hours = Number(settings?.disputeResponseWaitHours ?? 12);
    return Number.isFinite(hours) && hours >= 0 ? hours : 12;
  }

  private async getSubmissionAutoCompleteGraceHours(): Promise<number> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    const hours = Number(settings?.submissionAutoCompleteGraceHours ?? 48);
    return Number.isFinite(hours) && hours >= 0 ? hours : 48;
  }

  private getHostAutoCompleteAt(submission: any, waitHours = 24): Date | null {
    const submittedAtRaw =
      submission?.submittedAt || submission?.updatedAt || submission?.createdAt;
    if (!submittedAtRaw) return null;
    const submittedAt = new Date(submittedAtRaw);
    if (Number.isNaN(submittedAt.getTime())) return null;
    return new Date(submittedAt.getTime() + waitHours * 60 * 60 * 1000);
  }

  private async autoCompleteSubmission(
    submission: any,
    invite: any,
    now = new Date(),
  ) {
    submission.status = "approved";
    submission.brandFeedback =
      submission.brandFeedback ||
      "Auto-completed after the host review window expired without response.";
    submission.reviewedAt = now;
    submission.autoCompletedAt = now;
    await submission.save();

    invite.status = "completed";
    invite.completedAt = now;
    await invite.save();

    const inviteId = String(invite._id || submission.inviteId || "");
    const txQuery: any = {
      $or: [{ inviteId }],
    };
    if (Types.ObjectId.isValid(inviteId)) {
      txQuery.$or.push({ inviteId: new Types.ObjectId(inviteId) });
    }
    const txs = await this.campaignTransactionModel.find(txQuery);
    for (const tx of txs) {
      tx.workStatus = "approved";
      tx.payoutStatus =
        tx.collectionStatus === "verified" ? "processing" : "pending";
      await tx.save();
    }
  }

  private normalizeRecipientRole(role: any): "influencer" | "photographer" {
    return String(role || "influencer")
      .trim()
      .toLowerCase() === "photographer"
      ? "photographer"
      : "influencer";
  }

  private getAcceptedSlotStatuses(): string[] {
    return [
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
    ];
  }

  private getRoleAcceptanceCloseAt(
    campaign: any,
    role: "influencer" | "photographer",
  ): number {
    const slots = Array.isArray(campaign?.inviteSlots)
      ? campaign.inviteSlots
      : [];
    const slotTotal = slots.reduce((sum: number, slot: any) => {
      const slotRole = this.normalizeRecipientRole(slot?.role);
      const count = Number(slot?.count || 0);
      return slotRole === role && Number.isFinite(count) && count > 0
        ? sum + Math.round(count)
        : sum;
    }, 0);
    if (slotTotal > 0) return slotTotal;

    if (role === "photographer") {
      const photographerLimit = Number(
        campaign?.maxPhotographers ||
          campaign?.maxPhotoVideoGraphers ||
          campaign?.maxPhotovideographers ||
          campaign?.maxPhotoVideographers ||
          0,
      );
      if (Number.isFinite(photographerLimit) && photographerLimit > 0) {
        return Math.round(photographerLimit);
      }
    }

    const legacyLimit = Number(campaign?.maxInfluencers || 0);
    return Number.isFinite(legacyLimit) && legacyLimit > 0
      ? Math.round(legacyLimit)
      : 0;
  }

  private async countAcceptedForRole(
    campaignId: any,
    role: "influencer" | "photographer",
  ): Promise<number> {
    return this.inviteModel.countDocuments({
      campaignId,
      status: { $in: this.getAcceptedSlotStatuses() },
      $or: this.getRoleInviteQuery(role),
    });
  }

  private getRoleInviteQuery(role: "influencer" | "photographer"): any[] {
    return role === "photographer"
      ? [
          { recipientRole: "photographer" },
          { photographerId: { $exists: true, $ne: null } },
        ]
      : [
          { recipientRole: "influencer" },
          { recipientRole: { $exists: false } },
          { recipientRole: null },
          { recipientRole: "" },
          { influencerId: { $exists: true, $ne: null } },
        ];
  }

  private async withdrawRemainingPendingInvitesForClosedRole(
    campaignId: any,
    acceptedInviteId: any,
    role: "influencer" | "photographer",
    closeAt: number,
  ): Promise<void> {
    if (!closeAt || closeAt <= 0) return;
    const acceptedCount = await this.countAcceptedForRole(campaignId, role);
    if (acceptedCount < closeAt) return;

    await this.inviteModel.updateMany(
      {
        _id: { $ne: acceptedInviteId },
        campaignId,
        status: { $in: ["pending", "invited", "counter_sent"] },
        $or: this.getRoleInviteQuery(role),
      },
      {
        $set: {
          status: "withdrawn",
          withdrawnAt: new Date(),
          withdrawnReason: `Auto-closed after ${closeAt} ${role} acceptance${closeAt === 1 ? "" : "s"}.`,
          updatedAt: new Date(),
        },
      },
    );
  }

  private async safeFindById(
    model: any,
    id: string,
    selectFields: string,
  ): Promise<Record<string, any> | null> {
    try {
      const query = model?.findById?.(id);
      if (!query) return null;
      if (typeof query.select === "function") {
        const selected = query.select(selectFields);
        if (selected && typeof selected.lean === "function") {
          return await selected.lean();
        }
        return await selected;
      }
      if (typeof query.lean === "function") {
        return await query.lean();
      }
      return await query;
    } catch {
      return null;
    }
  }

  private async safeFindOne(
    model: any,
    filter: any,
    selectFields: string,
  ): Promise<Record<string, any> | null> {
    try {
      const query = model?.findOne?.(filter);
      if (!query) return null;
      if (typeof query.select === "function") {
        const selected = query.select(selectFields);
        if (selected && typeof selected.lean === "function") {
          return await selected.lean();
        }
        return await selected;
      }
      if (typeof query.lean === "function") {
        return await query.lean();
      }
      return await query;
    } catch {
      return null;
    }
  }

  private async resolveOwnerIdentifiers(ownerId: string): Promise<string[]> {
    const normalized = String(ownerId || "").trim();
    if (!normalized) return [];

    const docs = await Promise.all([
      this.safeFindOne(
        this.brandModel,
        {
          $or: [
            { _id: normalized },
            { brandUsername: normalized },
            { username: normalized },
          ],
        },
        "_id brandUsername username",
      ),
      this.safeFindOne(
        this.photographerModel,
        {
          $or: [
            { _id: normalized },
            { username: normalized },
            { photographerUsername: normalized },
          ],
        },
        "_id username photographerUsername",
      ),
      this.safeFindOne(
        this.influencerModel,
        {
          $or: [{ _id: normalized }, { username: normalized }],
        },
        "_id username",
      ),
    ]);

    const values = new Set<string>([normalized]);
    for (const doc of docs) {
      if (!doc || typeof doc !== "object") continue;
      const anyDoc: any = doc;
      for (const key of [
        "_id",
        "brandUsername",
        "username",
        "photographerUsername",
      ]) {
        const raw = anyDoc?.[key];
        if (raw !== undefined && raw !== null && String(raw).trim()) {
          values.add(String(raw).trim());
        }
      }
    }
    return Array.from(values);
  }

  private getRecipientModel(role: "influencer" | "photographer") {
    return role === "photographer"
      ? this.photographerModel
      : this.influencerModel;
  }

  private async loadRecipientProfile(
    role: "influencer" | "photographer",
    recipientId: string,
  ) {
    return this.getRecipientModel(role)
      .findById(recipientId)
      .select(
        "name email phoneNumber username profileImages socialMedia location isPremium premiumEnd createdAt premiumStart contact isEmailVerified isMobileVerified",
      )
      .lean();
  }

  private async loadOwnerPlanAnchor(ownerId: string) {
    const [brand, influencer, photographer] = await Promise.all([
      this.brandModel
        .findById(ownerId)
        .select("createdAt premiumStart premiumEnd isPremium")
        .lean(),
      this.influencerModel
        .findById(ownerId)
        .select("createdAt premiumStart premiumEnd isPremium")
        .lean(),
      this.photographerModel
        .findById(ownerId)
        .select("createdAt premiumStart premiumEnd isPremium")
        .lean(),
    ]);
    return brand || influencer || photographer || null;
  }

  private async loadOwnerVerificationProfile(ownerId: string) {
    const select = "isEmailVerified isMobileVerified";
    const [brand, photographer] = await Promise.all([
      this.brandModel.findById(ownerId).select(select).lean(),
      this.photographerModel.findById(ownerId).select(select).lean(),
    ]);
    return brand || photographer || null;
  }

  private assertVerifiedForCampaignAccess(profile: any, label: string) {
    if (profile?.isEmailVerified === true && profile?.isMobileVerified === true) {
      return;
    }
    throw new BadRequestException(
      `${label} must verify both email and mobile before sending or receiving campaign invitations.`,
    );
  }

  private async resolveSenderProfile(ownerId: string): Promise<{
    role: "brand" | "influencer" | "photographer";
    name: string;
    email?: string;
  }> {
    const brand: any = await this.safeFindById(
      this.brandModel,
      ownerId,
      "brandName name email",
    );
    if (brand) {
      return {
        role: "brand",
        name:
          String(brand.brandName || brand.name || "Brand").trim() || "Brand",
        email: brand.email,
      };
    }

    const influencer: any = await this.safeFindById(
      this.influencerModel,
      ownerId,
      "name email",
    );
    if (influencer) {
      return {
        role: "influencer",
        name: String(influencer.name || "Influencer").trim() || "Influencer",
        email: influencer.email,
      };
    }

    const photographer: any = await this.safeFindById(
      this.photographerModel,
      ownerId,
      "name email",
    );
    if (photographer) {
      return {
        role: "photographer",
        name:
          String(photographer.name || "Photographer").trim() || "Photographer",
        email: photographer.email,
      };
    }

    return { role: "brand", name: "Creator" };
  }

  private isInviteContactVisible(invite: any): boolean {
    const status = String(invite?.status || "")
      .trim()
      .toLowerCase();
    const paymentConfirmedOrLater = new Set([
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "disputed",
    ]).has(status);
    if (paymentConfirmedOrLater) return true;

    // Universal rule across all plans/types:
    // accepted + sender-unlocked OR payment_confirmed+
    return (
      !!invite?.unlocked &&
      new Set([
        "accepted",
        "payment_confirmed",
        "working",
        "submitted",
        "completed",
        "approved",
        "disputed",
      ]).has(status)
    );
  }

  private isLocationDetailsPaymentConfirmed(invite: any): boolean {
    const status = String(invite?.status || "")
      .trim()
      .toLowerCase();
    const paymentConfirmedOrLater = new Set([
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "disputed",
    ]).has(status);

    if (paymentConfirmedOrLater) return true;

    // Universal rule across all plans/types:
    // accepted + sender-unlocked OR payment_confirmed+
    // to reveal exact venue/map details.
    if (!invite?.unlocked) return false;
    return new Set([
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "disputed",
    ]).has(status);
  }

  private redactExactLocationDetails(campaign: any): any {
    if (!campaign || typeof campaign !== "object") return campaign;
    const redacted = { ...campaign };
    delete redacted.venueName;
    delete redacted.venueAddress;
    delete redacted.venueGoogleMapUrl;
    delete redacted.venueMapUrl;
    delete redacted.shootLocationAddress;
    delete redacted.shootLocationMapUrl;
    delete redacted.shootLocationNotes;
    return redacted;
  }

  private applyRecipientLocationVisibility(invite: any): any {
    if (this.isLocationDetailsPaymentConfirmed(invite)) {
      return invite;
    }

    const campaign = invite?.campaignId;
    if (!campaign || typeof campaign !== "object") {
      return invite;
    }

    const redactedCampaign = this.redactExactLocationDetails(campaign);
    return {
      ...invite,
      campaignId: redactedCampaign,
      ...(invite?.campaign && typeof invite.campaign === "object"
        ? { campaign: redactedCampaign }
        : {}),
    };
  }

  private omitContactFields<T extends Record<string, any>>(
    value: T,
  ): Omit<T, "email" | "phoneNumber"> {
    const clone = { ...(value || {}) };
    delete clone.email;
    delete clone.phoneNumber;
    return clone;
  }

  private async attachRecipientProfile(invite: any) {
    const role = this.normalizeRecipientRole(
      invite?.recipientRole ||
        invite?.role ||
        (invite?.photographerId && !invite?.influencerId
          ? "photographer"
          : "influencer"),
    );
    const recipientId = String(
      invite?.influencerId?._id ||
        invite?.influencerId ||
        invite?.photographerId?._id ||
        invite?.photographerId ||
        invite?.recipientId ||
        "",
    ).trim();
    if (!recipientId) {
      return invite;
    }

    const recipient = await this.loadRecipientProfile(role, recipientId);
    if (!recipient) {
      return invite;
    }

    if (!this.isInviteContactVisible(invite)) {
      const redactedRecipient = this.omitContactFields(
        recipient as Record<string, any>,
      );
      return {
        ...invite,
        recipientRole: role,
        influencerId: redactedRecipient,
        ...(role === "photographer"
          ? { photographerId: redactedRecipient }
          : {}),
      };
    }

    const recipientDoc: any = recipient as any;
    const hydratedRecipient = {
      ...recipientDoc,
      email: recipientDoc?.isEmailVerified ? recipientDoc?.email : undefined,
      phoneNumber: recipientDoc?.isMobileVerified
        ? recipientDoc?.phoneNumber
        : undefined,
    };
    return {
      ...invite,
      recipientRole: role,
      influencerId: hydratedRecipient,
      ...(role === "photographer" ? { photographerId: hydratedRecipient } : {}),
    };
  }

  /** True if user has an active premium right now. */
  private isCurrentlyPremium(user: any): boolean {
    if (!user?.isPremium) return false;
    if (!user.premiumEnd) return true;
    return new Date(user.premiumEnd) >= new Date();
  }

  /**
   * Per-user monthly cycle start. Anchor:
   *  - Pro user with active premium → premiumStart
   *  - Otherwise → createdAt (signup)
   * Returns the latest anchor + N months that is <= now.
   */
  private computePlanCycleStart(user: any, now: Date = new Date()): Date {
    const isPremium = this.isCurrentlyPremium(user);
    const anchorRaw =
      isPremium && user?.premiumStart ? user.premiumStart : user?.createdAt;
    const anchor = anchorRaw ? new Date(anchorRaw) : new Date(0);
    if (anchor > now) return anchor;
    const cycle = new Date(anchor);
    while (true) {
      const next = new Date(cycle);
      next.setMonth(next.getMonth() + 1);
      if (next > now) break;
      cycle.setTime(next.getTime());
    }
    return cycle;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async autoApproveStaleSubmissionsCron() {
    await this.autoApproveStaleSubmissions();
  }

  async autoApproveStaleSubmissions() {
    const waitHours = await this.getSubmissionApprovalWaitHours();
    const cutoff = new Date(Date.now() - waitHours * 60 * 60 * 1000);
    const staleSubmissions = await this.submissionModel
      .find({
        status: "submitted",
        hostAutoCompleteEnabled: true,
        submittedAt: { $lte: cutoff },
      })
      .lean();

    let autoApprovedCount = 0;

    for (const stale of staleSubmissions) {
      const submission = await this.submissionModel.findById(stale._id);
      if (!submission || submission.status !== "submitted") continue;

      const invite = await this.inviteModel.findById(submission.inviteId);
      if (!invite) continue;

      await this.autoCompleteSubmission(submission, invite);

      // Auto-approved post emails are disabled by product request.

      autoApprovedCount++;
    }

    return {
      success: true,
      autoApprovedCount,
      waitHours,
      totalHours: waitHours,
    };
  }

  async create(brandId: string, data: any) {
    const campaign: any = await this.campaignModel
      .findById(data.campaignId)
      .lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    // Allow if campaign owner matches creator id/username across supported owner profiles.
    if (String(campaign.brandId) !== brandId) {
      const ownerIdentifiers = await this.resolveOwnerIdentifiers(brandId);
      if (!ownerIdentifiers.includes(String(campaign.brandId))) {
        throw new BadRequestException("Not your campaign");
      }
    }
    const ownerProfile = await this.loadOwnerVerificationProfile(brandId);
    this.assertVerifiedForCampaignAccess(ownerProfile, "Campaign owner");
    // Collaboration invites can be queued by the owner even while pending_review.
    // Recipients will not be able to accept until the collaboration goes live.
    // Block only truly terminal/unknown states (rejected, completed, draft).
    if (this.isCollaborationCampaign(campaign)) {
      const campStatus = String(campaign?.status || "")
        .trim()
        .toLowerCase();
      const allowedForOwner = new Set([
        "active",
        "pending",
        "pending_review",
        "needs_changes",
      ]);
      if (!allowedForOwner.has(campStatus)) {
        throw new BadRequestException(
          "Invites can only be sent for active or pending-review collaborations.",
        );
      }
    }
    const recipientRole = this.normalizeRecipientRole(data?.recipientRole);
    const recipientId = String(
      data?.recipientId || data?.influencerId || data?.photographerId || "",
    ).trim();
    if (!recipientId) {
      throw new BadRequestException("Recipient is required");
    }
    const recipientDoc: any = await this.loadRecipientProfile(
      recipientRole,
      recipientId,
    );
    if (!recipientDoc) {
      throw new BadRequestException(
        recipientRole === "photographer"
          ? "Photographer not found"
          : "Influencer not found",
      );
    }
    this.assertVerifiedForCampaignAccess(recipientDoc, "Recipient");
    await this.profileVerificationService.assertCampaignEligible(
      recipientId,
      recipientRole,
    );
    // Enforce invite limits for brands (admin-manageable)
    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const capFeatures = Array.isArray(caps?.features) ? caps.features : [];
    const capLimits = Array.isArray(caps?.limits) ? caps.limits : [];
    const configuredMaxInvitesPerCampaign = capLimits.find(
      (l: any) => l.key === "maxInvitesPerCampaign",
    )?.value;
    const maxInvitesPerCampaign =
      configuredMaxInvitesPerCampaign !== undefined
        ? Number(configuredMaxInvitesPerCampaign)
        : caps?.hasPremium
          ? 10
          : 1;
    const canInviteUsers = capFeatures.some(
      (f: any) => String(f?.key || "") === "canInviteUsers" && !!f?.value,
    );
    const canInviteByLimit =
      Number(maxInvitesPerCampaign) === -1 || Number(maxInvitesPerCampaign) > 0;
    if (!canInviteUsers && !canInviteByLimit) {
      throw new BadRequestException(
        "Upgrade to Premium to send collaboration invites.",
      );
    }
    const maxInvitesPerMonthEntry = capLimits.find(
      (l: any) => l.key === "maxInvitesPerMonth",
    );
    // Count invites for this campaign. Invite volume is controlled by the
    // sender's plan; campaign.maxInfluencers is the accepted-slot close target.
    const inviteCount = await this.inviteModel.countDocuments({
      campaignId: data.campaignId,
    });
    const acceptanceCloseAt = this.getRoleAcceptanceCloseAt(
      campaign,
      recipientRole,
    );
    if (
      campaign?.acceptanceDeadline &&
      Date.now() > new Date(campaign.acceptanceDeadline).getTime()
    ) {
      throw new BadRequestException(
        "Campaign acceptance is closed by deadline.",
      );
    }
    if (acceptanceCloseAt > 0) {
      // 'disputed' excluded so no-show slots can be re-filled
      const acceptedCount = await this.countAcceptedForRole(
        data.campaignId,
        recipientRole,
      );
      if (acceptedCount >= acceptanceCloseAt) {
        throw new BadRequestException(
          `Campaign acceptance is closed for ${recipientRole}s (${acceptedCount}/${acceptanceCloseAt} reached).`,
        );
      }
    }
    if (maxInvitesPerCampaign !== -1 && inviteCount >= maxInvitesPerCampaign) {
      throw new BadRequestException(
        `Plan limit: Only ${maxInvitesPerCampaign} invites per campaign allowed. Upgrade for more.`,
      );
    }
    // Per-month cap only applies when explicitly set in the plan
    if (
      maxInvitesPerMonthEntry !== undefined &&
      maxInvitesPerMonthEntry.value !== -1
    ) {
      const ownerDoc = await this.loadOwnerPlanAnchor(brandId);
      const cycleStart = this.computePlanCycleStart(ownerDoc);
      const monthInviteCount = await this.inviteModel.countDocuments({
        brandId,
        createdAt: { $gte: cycleStart },
      });
      if (monthInviteCount >= maxInvitesPerMonthEntry.value) {
        throw new BadRequestException(
          `Plan limit: Only ${maxInvitesPerMonthEntry.value} campaign(s) with invites per month allowed. Upgrade for more.`,
        );
      }
    }

    // Enforce recipient cap (anchored to the recipient's plan-start)
    const recipientCaps =
      await this.plansService.getUserPlanCapabilities(recipientId);
    const recipientLimits = Array.isArray(recipientCaps?.limits)
      ? recipientCaps.limits
      : [];
    if (recipientDoc) {
      const recipientMonthlyCap =
        recipientLimits.find((l: any) => l.key === "maxInvitesPerCampaign")
          ?.value ?? -1;
      if (recipientMonthlyCap !== -1) {
        const recipientCycleStart = this.computePlanCycleStart(recipientDoc);
        const now = new Date();
        const recipientMonthCount = await this.inviteModel.countDocuments({
          influencerId: recipientId,
          recipientRole,
          createdAt: { $gte: recipientCycleStart },
          $or: [
            {
              status: {
                $in: [
                  "accepted",
                  "payment_confirmed",
                  "working",
                  "submitted",
                  "approved",
                  "completed",
                ],
              },
            },
            {
              $and: [
                { status: { $in: ["pending", "invited"] } },
                { overdueFlaggedAt: { $in: [null, undefined] } },
                {
                  $or: [
                    { dueDate: { $in: [null, undefined] } },
                    { dueDate: { $gte: now } },
                  ],
                },
              ],
            },
          ],
        });
        if (recipientMonthCount >= recipientMonthlyCap) {
          throw new BadRequestException(
            `This ${recipientRole} has reached their monthly invite limit (${recipientMonthlyCap}). Try again after their next cycle.`,
          );
        }
      }
    }

    let normalizedDueDate: Date | null = null;
    if (data?.dueDate) {
      const parsedDueDate = new Date(data.dueDate);
      if (!Number.isNaN(parsedDueDate.getTime())) {
        normalizedDueDate = parsedDueDate;
      }
    }
    if (!normalizedDueDate && campaign?.acceptanceDeadline) {
      const parsedDeadline = new Date(campaign.acceptanceDeadline);
      if (!Number.isNaN(parsedDeadline.getTime())) {
        normalizedDueDate = parsedDeadline;
      }
    }

    const invite = new this.inviteModel({
      ...data,
      brandId,
      influencerId: recipientId,
      recipientRole,
      dueDate: normalizedDueDate,
    });
    const saved = await invite.save();

    if (this.isCampaignLiveForRecipient(campaign)) {
      try {
        const sender = await this.resolveSenderProfile(brandId);
        // New campaign invite emails are disabled by product request.
        // Push notification to recipient
        this.pushService
          .sendToUser(String(recipientId), {
            title: "New Campaign Invite 🎉",
            body: `${sender.name || "A creator"} invited you to "${campaign.title}"`,
            url:
              recipientRole === "photographer"
                ? "/photographer-dashboard"
                : "/influencer-dashboard",
          }, 'campaign')
          .catch(() => {
            /* non-critical */
          });
        this.notificationsService
          .createForUser({
            userId: String(recipientId),
            userRole: recipientRole,
            title: "New Campaign Invite",
            body: `${sender.name || "A creator"} invited you to "${campaign.title}"`,
            url:
              recipientRole === "photographer"
                ? "/photographer-dashboard"
                : "/influencer-dashboard",
          })
          .catch(() => {
            /* non-critical */
          });
      } catch (err) {
        console.error("Failed to send invite notification:", err);
      }
    }

    return saved;
  }

  async findByCampaign(
    campaignId: string,
    requesterId?: string,
    requesterRole?: string,
  ) {
    if (requesterId && String(requesterRole || "").toLowerCase() !== "admin") {
      const campaign: any = await this.campaignModel
        .findById(campaignId)
        .select("brandId")
        .lean();
      if (!campaign || String(campaign.brandId) !== String(requesterId)) {
        throw new BadRequestException("Not your campaign");
      }
    }
    // Query using both string and ObjectId forms to handle legacy/mixed data
    try {
      const { Types } = await import("mongoose");
      const queries: any[] = [{ campaignId }];
      if (/^[a-fA-F0-9]{24}$/.test(campaignId)) {
        queries.push({ campaignId: new Types.ObjectId(campaignId) });
      }
      const invites = await this.inviteModel.find({ $or: queries }).lean();

      const enriched = await Promise.all(
        (Array.isArray(invites) ? invites : []).map((inv: any) =>
          this.attachRecipientProfile(inv),
        ),
      );

      const isAdmin = String(requesterRole || "").toLowerCase() === "admin";
      if (isAdmin) {
        const withSubmissions = await this.attachLatestSubmissions(enriched);
        return this.attachLatestPayouts(withSubmissions);
      }
      return enriched;
    } catch {
      return [];
    }
  }

  private normalizeInfluencerInviteScope(
    scope?: string,
  ): "campaign" | "collaboration" | null {
    const normalized = String(scope || "")
      .trim()
      .toLowerCase();
    if (normalized === "campaign") return "campaign";
    if (normalized === "collaboration") return "collaboration";
    return null;
  }

  private isCollaborationCampaign(campaign: any): boolean {
    const ownerType = String(
      campaign?.ownerType || campaign?.createdByRole || "",
    )
      .trim()
      .toLowerCase();
    const requestKind = String(campaign?.requestKind || "")
      .trim()
      .toLowerCase();
    return (
      ownerType === "photographer" ||
      ownerType === "videographer" ||
      requestKind === "photographer_collaboration" ||
      requestKind === "videographer_collaboration"
    );
  }

  private isCampaignLiveForRecipient(campaign: any): boolean {
    const status = String(campaign?.status || "")
      .trim()
      .toLowerCase();
    return status === "active" || status === "completed";
  }

  private assertCampaignLiveForRecipient(campaign: any, action: string) {
    if (this.isCampaignLiveForRecipient(campaign)) return;
    throw new BadRequestException(
      `This campaign/collaboration is still under admin review. You can ${action} after it is approved.`,
    );
  }

  /**
   * Once a host ends a campaign, no new forward progress (accept/start work/submit) should
   * be possible, regardless of any individual invite's selected posting date. Deliberately
   * separate from `assertCampaignLiveForRecipient` — that one still treats 'completed' as
   * live for read/contact-unlock purposes; this one is only for actions that create new work.
   */
  private assertCampaignNotEnded(campaign: any, action: string) {
    const status = String(campaign?.status || "").trim().toLowerCase();
    if (status === "completed") {
      throw new BadRequestException(
        `This campaign has ended. You can no longer ${action}.`,
      );
    }
  }

  /**
   * Single source of truth for the late-submission grace window. Follows the same pure
   * duration-arithmetic convention already used for `insightsUnlocksAt` (selectedPostDate +
   * 24h) rather than any calendar-day/timezone logic — selectedPostDate is a UTC-midnight
   * instant of the chosen date, so a fixed millisecond offset never crosses into the wrong day.
   */
  private computeGraceDeadline(
    invite: any,
    campaign: any,
  ): { isLate: boolean; daysLate: number; closesAt: Date } {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const strictDeadline = new Date(
      new Date(invite.selectedPostDate).getTime() + ONE_DAY_MS,
    );
    const closesAt =
      campaign?.postingDeadlineMode === "strict"
        ? strictDeadline
        : new Date(strictDeadline.getTime() + ONE_DAY_MS);
    const now = Date.now();
    const isLate = now > strictDeadline.getTime();
    const daysLate = isLate
      ? Math.ceil((now - strictDeadline.getTime()) / ONE_DAY_MS)
      : 0;
    return { isLate, daysLate, closesAt };
  }

  private toPaiseFromMaybeRupees(value: any): number {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Invite card prices/counters are entered in rupees.
    return Math.round(n * 100);
  }

  private toRupeesFromPaise(value: any): number {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n / 100);
  }

  private isDeliverableBasedPricing(
    campaign: any,
    recipientRole: "influencer" | "photographer",
  ): boolean {
    const t = String(campaign?.campaignType || "")
      .trim()
      .toLowerCase();
    const ownerType = String(
      campaign?.ownerType || campaign?.createdByRole || "",
    )
      .trim()
      .toLowerCase();
    if (t === "reel_collab") return true;
    if (
      t === "paid_collab" &&
      ownerType !== "photographer" &&
      recipientRole === "influencer"
    )
      return true;
    // invite_location campaigns can configure per-content-type pricing in socialMedia.
    if (t === "invite_location" && Array.isArray(campaign?.socialMedia)) {
      return campaign.socialMedia.some(
        (sm: any) =>
          Array.isArray(sm?.contentTypes) &&
          sm.contentTypes.some(
            (ct: any) => ct?.enabled && Number(ct?.price || 0) > 0,
          ),
      );
    }
    return false;
  }

  private resolveDeliverableOfferRupees(
    campaign: any,
    selectedPlatform?: string,
    selectedContentType?: string,
  ): number {
    if (
      !selectedPlatform ||
      !selectedContentType ||
      !Array.isArray(campaign?.socialMedia)
    ) {
      return 0;
    }
    const smEntry = campaign.socialMedia.find(
      (sm: any) =>
        String(sm?.platform || "").toLowerCase() ===
        String(selectedPlatform || "").toLowerCase(),
    );
    const ctEntry = smEntry?.contentTypes?.find(
      (ct: any) =>
        String(ct?.name || "").toLowerCase() ===
          String(selectedContentType || "").toLowerCase() && !!ct?.enabled,
    );
    const rupees = Number(ctEntry?.price || 0);
    return Number.isFinite(rupees) && rupees > 0 ? rupees : 0;
  }

  private isCampaignDeletedForRecipient(campaign: any): boolean {
    if (!campaign || typeof campaign !== "object") return true;
    const status = String(campaign?.status || "")
      .trim()
      .toLowerCase();
    return (
      campaign?.isDeleted === true ||
      !!campaign?.deletedAt ||
      status === "deleted"
    );
  }

  private isCollaborationInvite(
    invite: any,
    photographerOwnerIds?: Set<string>,
  ): boolean {
    const campaign = invite?.campaignId || {};
    const ownerType = String(
      campaign?.ownerType || campaign?.createdByRole || "",
    )
      .trim()
      .toLowerCase();
    const requestKind = String(campaign?.requestKind || "")
      .trim()
      .toLowerCase();
    if (
      ownerType === "photographer" ||
      ownerType === "videographer" ||
      requestKind === "photographer_collaboration" ||
      requestKind === "videographer_collaboration"
    ) {
      return true;
    }
    return photographerOwnerIds?.has(String(campaign?.brandId || "")) || false;
  }

  private async attachLatestSubmissions(invites: any[]): Promise<any[]> {
    const inviteIds = (invites || [])
      .map((invite: any) => String(invite?._id || ""))
      .filter(Boolean);
    if (!inviteIds.length) return invites || [];

    const inviteObjectIds = inviteIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const submissionQuery: any = {
      $or: [{ inviteId: { $in: inviteIds } }],
    };
    if (inviteObjectIds.length) {
      submissionQuery.$or.push({ inviteId: { $in: inviteObjectIds } });
    }

    const submissions: any[] = await this.submissionModel
      .find(submissionQuery)
      .select(
        "inviteId postUrl postType postPlatform status submittedAt reviewedAt autoCompletedAt hostAutoCompleteEnabled hostAutoCompleteEnabledAt createdAt updatedAt brandFeedback disputeIssueReason disputeReason disputeEvidenceUrl resubmissionCount",
      )
      .sort({ submittedAt: -1, createdAt: -1 })
      .lean();

    const byInviteId = new Map<string, any>();
    for (const submission of submissions || []) {
      const key = String(submission?.inviteId || "");
      if (key && !byInviteId.has(key)) {
        byInviteId.set(key, submission);
      }
    }

    return (invites || []).map((invite: any) => ({
      ...invite,
      latestSubmission: byInviteId.get(String(invite?._id || "")) || null,
    }));
  }

  private async attachLatestPayouts(invites: any[]): Promise<any[]> {
    const inviteIds = (invites || [])
      .map((invite: any) => String(invite?._id || ""))
      .filter(Boolean);
    if (!inviteIds.length) return invites || [];

    const inviteObjectIds = inviteIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const txQuery: any = {
      $or: [{ inviteId: { $in: inviteIds } }],
    };
    if (inviteObjectIds.length) {
      txQuery.$or.push({ inviteId: { $in: inviteObjectIds } });
    }

    const transactions: any[] = await this.campaignTransactionModel
      .find(txQuery)
      .select("inviteId payerTotal recipientPayout gateway gatewayOrderId gatewayPaymentId utrNumber payoutStatus payoutGatewayProvider payoutInitiatedAt payoutSettledAt payoutTransferId payoutUtr")
      .lean();

    const byInviteId = new Map<string, any>();
    for (const tx of transactions || []) {
      const key = String(tx?.inviteId || "");
      if (key) byInviteId.set(key, tx);
    }

    return (invites || []).map((invite: any) => ({
      ...invite,
      latestPayout: byInviteId.get(String(invite?._id || "")) || null,
    }));
  }

  async findByInfluencer(influencerId: string, scope?: string) {
    const invites: any[] = await this.inviteModel
      .find({
        influencerId,
        $or: [
          { recipientRole: { $exists: false } },
          { recipientRole: "influencer" },
        ],
      })
      .populate(
        "campaignId",
        "title description status campaignMode budgetMin budgetMax campaignType pricePerInfluencer maxInfluencers startDate endDate timelineStart timelineEnd acceptanceDeadline deliverables platforms socialMedia specialInstructions venueName venueAddress venueCity venueDistrict venueState venueGoogleMapUrl productValue productDescription productPaymentMode productPaymentAmount inviteBenefits payToJoinBenefits payToJoinInstructions ownerType createdByRole requestKind brandId image images galleryImages promotionUrlType promotionUrl suggestedCaption hashtags resourceImages campaignNumber",
      )
      .populate(
        "brandId",
        "brandName brandUsername brandLogo location categories website email phoneNumber isEmailVerified isMobileVerified",
      )
      .lean();

    const campaignOwnerIds = [
      ...new Set(
        (invites || [])
          .map((inv: any) => String(inv?.campaignId?.brandId || ""))
          .filter(Boolean),
      ),
    ];
    const photographerOwnerRows: any[] = campaignOwnerIds.length
      ? await this.photographerModel
          .find({ _id: { $in: campaignOwnerIds } })
          .select("_id")
          .lean()
      : [];
    const photographerOwnerIds = new Set(
      (photographerOwnerRows || [])
        .map((p: any) => String(p?._id || ""))
        .filter(Boolean),
    );

    const feedScope = this.normalizeInfluencerInviteScope(scope);
    const scoped = (invites || []).filter((inv: any) => {
      if (!feedScope) return true;
      const isCollab = this.isCollaborationInvite(inv, photographerOwnerIds);
      return feedScope === "collaboration" ? isCollab : !isCollab;
    });

    const visible = scoped.filter((inv: any) => {
      const campaign = inv?.campaignId;
      if (!campaign) return false;
      if (this.isCampaignDeletedForRecipient(campaign)) return false;
      return this.isCampaignLiveForRecipient(campaign);
    });

    const visibleWithSubmissions = await this.attachLatestSubmissions(visible);

    // Strip brand contact details from invites that haven't been unlocked yet
    return visibleWithSubmissions.map((rawInv: any) => {
      const inv = this.applyRecipientLocationVisibility(rawInv);
      if (inv.brandId) {
        const shouldShowContact = this.isInviteContactVisible(inv);
        if (!shouldShowContact) {
          const safeB = this.omitContactFields(inv.brandId);
          return { ...inv, brandId: safeB };
        }
        const safeBrand = {
          ...inv.brandId,
          // Once contact is unlocked, both sides should see the brand's saved contact details.
          email: inv.brandId?.email,
          phoneNumber: inv.brandId?.phoneNumber,
        };
        return { ...inv, brandId: safeBrand };
      }
      return inv;
    });
  }

  async findByPhotographer(photographerId: string) {
    const invites: any[] = await this.inviteModel
      .find({
        influencerId: photographerId,
        $or: [
          { recipientRole: "photographer" },
          { recipientRole: { $exists: false } },
          { recipientRole: "influencer" },
        ],
      })
      .populate(
        "campaignId",
        "title description status campaignMode budgetMin budgetMax campaignType pricePerInfluencer maxInfluencers startDate endDate timelineStart timelineEnd acceptanceDeadline deliverables platforms socialMedia specialInstructions venueName venueAddress venueCity venueDistrict venueState venueGoogleMapUrl productValue productDescription productPaymentMode productPaymentAmount inviteBenefits payToJoinBenefits payToJoinInstructions image images galleryImages promotionUrlType promotionUrl suggestedCaption hashtags resourceImages campaignNumber",
      )
      .populate(
        "brandId",
        "brandName brandUsername brandLogo location categories website email phoneNumber isEmailVerified isMobileVerified",
      )
      .lean();

    const visible = (invites || []).filter((inv: any) => {
      const campaign = inv?.campaignId;
      if (!campaign) return false;
      if (this.isCampaignDeletedForRecipient(campaign)) return false;
      return this.isCampaignLiveForRecipient(campaign);
    });

    const visibleWithSubmissions = await this.attachLatestSubmissions(visible);

    return visibleWithSubmissions.map((rawInv: any) => {
      const inv = this.applyRecipientLocationVisibility(rawInv);
      if (inv.brandId) {
        const shouldShowContact = this.isInviteContactVisible(inv);
        if (!shouldShowContact) {
          const safeB = this.omitContactFields(inv.brandId);
          return { ...inv, brandId: safeB };
        }
        const safeBrand = {
          ...inv.brandId,
          // Once contact is unlocked, both sides should see the brand's saved contact details.
          email: inv.brandId?.email,
          phoneNumber: inv.brandId?.phoneNumber,
        };
        return { ...inv, brandId: safeBrand };
      }
      return inv;
    });
  }

  /**
   * Used by brand to find a completed invite with a specific influencer,
   * so we know the brand is eligible to write a review.
   */
  async findCompletedByBrandAndInfluencer(
    brandId: string,
    influencerId: string,
  ) {
    const { Types } = await import("mongoose");
    const brandQueries: any[] = [{ brandId }];
    if (/^[a-fA-F0-9]{24}$/.test(brandId)) {
      brandQueries.push({ brandId: new Types.ObjectId(brandId) });
    }
    const influencerQueries: any[] = [{ influencerId }];
    if (/^[a-fA-F0-9]{24}$/.test(influencerId)) {
      influencerQueries.push({
        influencerId: new Types.ObjectId(influencerId),
      });
    }

    const invite = await this.inviteModel
      .findOne({
        $or: brandQueries,
        $and: [{ $or: influencerQueries }],
        status: "completed",
      })
      .lean();
    return invite ?? null;
  }

  async findOneWithCampaign(inviteId: string) {
    const invite = (await this.inviteModel.findById(inviteId).lean()) as any;
    if (!invite) throw new NotFoundException("Invite not found");
    const txQuery: any = {
      $or: [{ inviteId: String(invite._id) }, { inviteId: invite._id }],
    };
    const tx: any = await this.campaignTransactionModel
      .findOne(txQuery)
      .select("payoutStatus paidOutAt payoutSettledAt payoutUtr")
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
    const inviteForResponse = {
      ...invite,
      payoutStatus: tx?.payoutStatus || null,
      paidOutAt: invite?.paidOutAt || tx?.paidOutAt || tx?.payoutSettledAt || null,
      payoutUtr: tx?.payoutUtr || null,
      status:
        String(tx?.payoutStatus || "").toLowerCase() === "paid"
          ? "approved"
          : invite.status,
    };
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select(
        "title platforms socialMedia deliverables specialInstructions image images galleryImages postingDeadlineMode",
      )
      .lean();
    return { invite: inviteForResponse, campaign };
  }

  /**
   * Brand-initiated contact unlock.
   * Policy: unlock can only happen after payment-confirmed workflow states.
   */
  async unlockContact(inviteId: string, brandId: string) {
    const invite: any = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");

    // Authorize: caller must be the brand owner (ObjectId or brandUsername match)
    if (String(invite.brandId) !== brandId) {
      const brand = await this.brandModel
        .findById(brandId)
        .select("brandUsername")
        .lean();
      const brandUsername =
        brand && typeof brand === "object" && "brandUsername" in brand
          ? (brand as any).brandUsername
          : undefined;
      if (!brandUsername || String(invite.brandId) !== brandUsername) {
        throw new BadRequestException("Not your invite");
      }
    }

    // Already unlocked → idempotent return
    if (invite.unlocked) {
      return {
        success: true,
        alreadyUnlocked: true,
        unlockType: invite.unlockType,
        unlockedAt: invite.unlockedAt,
      };
    }

    // Fetch campaign to check type (gate differs by campaign type)
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select("campaignType status")
      .lean();
    this.assertCampaignLiveForRecipient(campaign, "unlock contact");
    const campaignType = String(campaign?.campaignType || "").toLowerCase();
    const isLocationCampaign =
      campaignType === "invite_location" || campaignType === "product";

    // For location/event campaigns unlock is allowed once accepted.
    // For paid collabs, payment confirmation is required first.
    const unlockableStatuses = isLocationCampaign
      ? new Set([
          "accepted",
          "payment_confirmed",
          "working",
          "submitted",
          "completed",
          "approved",
          "disputed",
        ])
      : new Set([
          "payment_confirmed",
          "working",
          "submitted",
          "completed",
          "approved",
          "disputed",
        ]);

    if (!unlockableStatuses.has(invite.status)) {
      const msg = isLocationCampaign
        ? "Invite must be accepted before contact can be unlocked."
        : "Payment confirmation is required before contact can be unlocked.";
      throw new BadRequestException(msg);
    }

    // Unlock type label
    const unlockType = "paid_collab_payment" as const;

    invite.unlocked = true;
    invite.unlockedAt = new Date();
    invite.unlockType = unlockType;
    await invite.save();

    return {
      success: true,
      unlocked: true,
      unlockType,
      unlockedAt: invite.unlockedAt,
    };
  }

  // ── Fulfillment / brand-action helpers ─────────────────────────

  /** Internal: load an invite and assert that the caller owns it (brand/influencer/photographer). */
  private async assertBrandOwnsInvite(inviteId: string, ownerId: string) {
    const invite: any = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    const inviteOwner = String(invite.brandId || "").trim();
    const possibleOwnerIds = await this.resolveOwnerIdentifiers(
      String(ownerId || "").trim(),
    );
    if (!possibleOwnerIds.includes(inviteOwner)) {
      throw new BadRequestException("Not your invite");
    }
    return invite;
  }

  /**
   * Brand updates product-shipping fulfillment for a `product` campaign invite.
   * Status auto-derives: trackingId set → shipped; deliveredAt set → delivered.
   */
  async updateProductFulfillment(
    inviteId: string,
    brandId: string,
    body: {
      courier?: string;
      trackingId?: string;
      trackingUrl?: string;
      shippedAt?: string | Date;
      deliveredAt?: string | Date;
      status?: "pending" | "shipped" | "delivered" | "returned";
      note?: string;
    },
  ) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    const campaign: any = await this.campaignModel.findById(invite.campaignId);
    if (!campaign || campaign.campaignType !== "product") {
      throw new BadRequestException(
        "Product fulfillment is only valid for `product` campaigns.",
      );
    }
    const pf = invite.productFulfillment || {};
    if (body.courier !== undefined) pf.courier = body.courier;
    if (body.trackingId !== undefined) pf.trackingId = body.trackingId;
    if (body.trackingUrl !== undefined) pf.trackingUrl = body.trackingUrl;
    if (body.shippedAt !== undefined) pf.shippedAt = new Date(body.shippedAt);
    if (body.deliveredAt !== undefined)
      pf.deliveredAt = new Date(body.deliveredAt);
    if (body.note !== undefined) pf.note = body.note;
    if (body.status) {
      pf.status = body.status;
    } else {
      // Auto-derive
      if (pf.deliveredAt) pf.status = "delivered";
      else if (pf.trackingId || pf.shippedAt) {
        pf.status = "shipped";
        if (!pf.shippedAt) pf.shippedAt = new Date();
      }
    }
    invite.productFulfillment = pf;
    invite.updatedAt = new Date();
    await invite.save();
    return { success: true, productFulfillment: pf };
  }

  /**
   * Brand marks an `invite_location` campaign visit as checked-in / no-show / cancelled,
   * or schedules a future visit.
   */
  async updateLocationCheckIn(
    inviteId: string,
    brandId: string,
    body: {
      status?: "pending" | "checked_in" | "no_show" | "cancelled";
      scheduledAt?: string | Date;
      checkedInAt?: string | Date;
      note?: string;
    },
  ) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    const campaign: any = await this.campaignModel.findById(invite.campaignId);
    if (!campaign || campaign.campaignType !== "invite_location") {
      throw new BadRequestException(
        "Check-in is only valid for `invite_location` campaigns.",
      );
    }
    const lv = invite.locationVisit || {};
    if (body.scheduledAt !== undefined)
      lv.scheduledAt = new Date(body.scheduledAt);
    if (body.note !== undefined) lv.note = body.note;
    if (body.status) {
      lv.status = body.status;
      if (body.status === "checked_in" && !lv.checkedInAt) {
        lv.checkedInAt = body.checkedInAt
          ? new Date(body.checkedInAt)
          : new Date();
      }
    } else if (body.checkedInAt) {
      lv.checkedInAt = new Date(body.checkedInAt);
      lv.status = "checked_in";
    }
    invite.locationVisit = lv;
    invite.updatedAt = new Date();
    await invite.save();
    return { success: true, locationVisit: lv };
  }

  /** Brand sets/updates the deliverable due-date for an invite. */
  async setInviteDueDate(
    inviteId: string,
    brandId: string,
    dueDate: string | Date | null,
  ) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    invite.dueDate = dueDate ? new Date(dueDate) : null;
    invite.updatedAt = new Date();
    await invite.save();
    return { success: true, dueDate: invite.dueDate };
  }

  /** Brand records that they've nudged the influencer; sends an email reminder. */
  async remindInvite(inviteId: string, brandId: string) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    // Throttle: max 1 reminder per 24h.
    const THROTTLE_MS = 24 * 60 * 60 * 1000;
    if (invite.remindedAt) {
      const diff = Date.now() - new Date(invite.remindedAt).getTime();
      if (diff < THROTTLE_MS) {
        const nextAt = new Date(
          new Date(invite.remindedAt).getTime() + THROTTLE_MS,
        );
        console.warn(
          `[remindInvite] throttled brand=${brandId} invite=${inviteId} nextAt=${nextAt.toISOString()}`,
        );
        throw new BadRequestException({
          message: "You already sent a reminder in the last 24 hours.",
          code: "REMIND_THROTTLED",
          nextReminderAvailableAt: nextAt.toISOString(),
          remindersSent: invite.remindersSent || 0,
        });
      }
    }
    invite.remindedAt = new Date();
    invite.remindersSent = (invite.remindersSent || 0) + 1;
    invite.updatedAt = new Date();
    await invite.save();

    // Best-effort email nudge to the influencer.
    try {
      const influencer: any = await this.influencerModel
        .findById(invite.influencerId)
        .select("email name")
        .lean();
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("title")
        .lean();
      const brand: any = await this.brandModel
        .findById(brandId)
        .select("brandName")
        .lean();
      if (influencer?.email) {
        const campaignTitle = campaign?.title || "a campaign";
        const brandName = brand?.brandName || "A brand";
        const inviteUrl =
          (process.env.FRONTEND_URL || "https://trendstarz.in").replace(
            /\/$/,
            "",
          ) + "/influencer-dashboard/invites";
        const reminderTpl = inviteReminderTemplate({
          recipientName: influencer.name || "",
          brandName,
          campaignTitle,
          dueDate: invite.dueDate ?? null,
          inviteUrl,
        });
        await sendAppEmail({ to: influencer.email, ...reminderTpl });
      }
    } catch (e) {
      console.error("Failed to send reminder email:", e);
    }

    return {
      success: true,
      remindedAt: invite.remindedAt,
      remindersSent: invite.remindersSent,
      nextReminderAvailableAt: new Date(
        new Date(invite.remindedAt).getTime() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    };
  }

  /** Brand withdraws a pending/accepted invite before execution starts.
   * Once the influencer is working (payment_confirmed / working / submitted / completed)
   * the invite is locked and cannot be withdrawn.
   */
  async withdrawInvite(inviteId: string, brandId: string, reason?: string) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    const lockedStatuses = new Set([
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "approved",
      "disputed",
    ]);
    if (lockedStatuses.has(invite.status)) {
      throw new BadRequestException(
        "This invite cannot be withdrawn because the creator has already started working. Use Report to flag an issue.",
      );
    }
    if (
      invite.status !== "pending" &&
      invite.status !== "accepted" &&
      invite.status !== "invited"
    ) {
      throw new BadRequestException(
        "Only pending or accepted invites can be withdrawn.",
      );
    }
    invite.status = "withdrawn";
    invite.withdrawnAt = new Date();
    if (reason) invite.withdrawnReason = reason;
    invite.updatedAt = new Date();
    await invite.save();
    return { success: true, status: invite.status };
  }

  /** Brand reports an issue (no-show / non-delivery / dispute). Flags invite for review. */
  async reportInviteIssue(inviteId: string, brandId: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException("A reason is required when reporting.");
    }
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    invite.reportedIssue = {
      reason: reason.trim(),
      reportedAt: new Date(),
    };
    // A report is a flag, not a status transition — the invite keeps showing its real
    // lifecycle stage (e.g. "Working") to host/admin/influencer; the report is surfaced
    // as a note on top of that status instead. Resolution happens via the existing admin
    // Disputes page (which now keys off reportedIssue regardless of invite.status), or
    // automatically once the influencer submits / the host approves.
    invite.updatedAt = new Date();
    await invite.save();
    this.invalidateAttentionCache();

    this.pushService
      .sendToUser(String(invite.influencerId), {
        title: "Host Reported an Issue",
        body: "A brand flagged an issue on your campaign collaboration.",
        url: "/influencer-dashboard",
      }, 'campaign')
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(invite.influencerId),
        userRole: "influencer",
        title: "Host Reported an Issue",
        body: "A brand flagged an issue on your campaign collaboration.",
        url: "/influencer-dashboard",
      })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, status: invite.status };
  }

  async respond(
    inviteId: string,
    influencerId: string,
    status: "accepted" | "declined" | "counter_sent",
    selectedPostDate?: string,
    selectedPlatform?: string,
    selectedContentType?: string,
    counterAmount?: number,
    counterMessage?: string,
    payout?: {
      upiId?: string;
      mobile?: string;
      accountHolderName?: string;
    },
    shippingAddress?: {
      contactName?: string;
      contactMobile?: string;
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      pincode?: string;
      landmark?: string;
    },
  ) {
    const normalized = (v: string) => (v || "").toLowerCase().trim();
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    const inviteStatus = String(invite.status || "").toLowerCase();
    const counterState = String(
      invite?.counterOffer?.status || "",
    ).toLowerCase();
    const isRecipientResolvingBrandCounter =
      inviteStatus === "counter_sent" &&
      counterState === "brand_sent" &&
      (status === "accepted" || status === "declined");
    const canRespondFromOpenInvite =
      inviteStatus === "pending" || inviteStatus === "invited";

    if (!canRespondFromOpenInvite && !isRecipientResolvingBrandCounter) {
      throw new BadRequestException("Invite already responded to");
    }

    if (status === "counter_sent") {
      const priorCounterStatus = String(
        invite?.counterOffer?.status || "",
      ).toLowerCase();
      const hasPriorCounter =
        priorCounterStatus === "sent" ||
        priorCounterStatus === "brand_sent" ||
        priorCounterStatus === "accepted" ||
        priorCounterStatus === "declined";
      if (hasPriorCounter) {
        throw new BadRequestException(
          "Only one counter offer is allowed per invite. Please accept or decline the invite.",
        );
      }
    }

    let recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
    let recipient = await this.loadRecipientProfile(
      recipientRole,
      influencerId,
    );
    if (!recipient) {
      const fallbackRole =
        recipientRole === "photographer" ? "influencer" : "photographer";
      const fallbackRecipient = await this.loadRecipientProfile(
        fallbackRole,
        influencerId,
      );
      if (fallbackRecipient) {
        recipientRole = fallbackRole;
        recipient = fallbackRecipient;
        // Self-heal legacy rows where recipientRole was saved incorrectly.
        invite.recipientRole = fallbackRole;
        if (fallbackRole === "photographer") {
          invite.photographerId = invite.influencerId;
        }
      }
    }
    if (!recipient) {
      throw new NotFoundException(
        recipientRole === "photographer"
          ? "Photographer not found"
          : "Influencer not found",
      );
    }

    if (status === "accepted" || status === "counter_sent") {
      await this.profileVerificationService.assertCampaignEligible(
        influencerId,
        recipientRole,
      );

      if (!selectedPostDate) {
        throw new BadRequestException(
          "selectedPostDate is required to respond",
        );
      }
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select(
          "status ownerType createdByRole requestKind startDate endDate timelineStart timelineEnd socialMedia platforms campaignMode minInfluencerTier minInfluencers maxInfluencers maxPhotographers maxPhotoVideoGraphers maxPhotovideographers maxPhotoVideographers inviteSlots acceptanceDeadline campaignType productShippingRequired",
        )
        .lean();
      if (!campaign) throw new NotFoundException("Campaign not found");

      this.assertCampaignLiveForRecipient(campaign, "accept");
      this.assertCampaignNotEnded(campaign, "accept");

      // Shipping address capture — required when brand is shipping a physical product.
      const requiresShippingAddress =
        campaign.campaignType === "product" &&
        campaign.productShippingRequired === true;
      if (requiresShippingAddress) {
        const sa = shippingAddress || {};
        const missing: string[] = [];
        const required: Array<[keyof typeof sa, string]> = [
          ["contactName", "contact name"],
          ["contactMobile", "contact mobile"],
          ["line1", "address line 1"],
          ["city", "city"],
          ["state", "state"],
          ["pincode", "pincode"],
        ];
        for (const [k, label] of required) {
          if (!String((sa as any)[k] || "").trim()) missing.push(label);
        }
        const mobile = String(sa.contactMobile || "").replace(/\D/g, "");
        if (mobile && (mobile.length < 10 || mobile.length > 13)) {
          missing.push("valid contact mobile");
        }
        const pincode = String(sa.pincode || "").replace(/\D/g, "");
        if (pincode && (pincode.length < 4 || pincode.length > 10)) {
          missing.push("valid pincode");
        }
        if (missing.length) {
          throw new BadRequestException(
            `Shipping address required to accept this product collab. Missing/invalid: ${missing.join(", ")}.`,
          );
        }
        invite.shippingAddress = {
          contactName: String(sa.contactName || "").trim(),
          contactMobile: String(sa.contactMobile || "").trim(),
          line1: String(sa.line1 || "").trim(),
          line2: String(sa.line2 || "").trim(),
          city: String(sa.city || "").trim(),
          state: String(sa.state || "").trim(),
          pincode: String(sa.pincode || "").trim(),
          landmark: String(sa.landmark || "").trim(),
          capturedAt: new Date(),
        };
      }

      const influencer =
        recipientRole === "photographer"
          ? await this.photographerModel
              .findById(influencerId)
              .select("socialMedia")
              .lean()
          : await this.influencerModel
              .findById(influencerId)
              .select("socialMedia")
              .lean();
      if (!influencer) {
        throw new NotFoundException(
          recipientRole === "photographer"
            ? "Photographer not found"
            : "Influencer not found",
        );
      }

      if (
        campaign?.acceptanceDeadline &&
        Date.now() > new Date(campaign.acceptanceDeadline).getTime()
      ) {
        throw new BadRequestException(
          "Campaign acceptance is closed by deadline.",
        );
      }

      const acceptanceCloseAt = this.getRoleAcceptanceCloseAt(
        campaign,
        recipientRole,
      );
      if (acceptanceCloseAt > 0) {
        // 'disputed' (no-show) is excluded so the slot re-opens for a replacement
        const acceptedCount = await this.countAcceptedForRole(
          invite.campaignId,
          recipientRole,
        );
        if (acceptedCount >= acceptanceCloseAt) {
          throw new BadRequestException(
            `Campaign is closed: required ${recipientRole} count reached (${acceptanceCloseAt}).`,
          );
        }
      }

      const campaignStart = campaign.startDate || campaign.timelineStart;
      const campaignEnd = campaign.endDate || campaign.timelineEnd;
      if (!campaignStart || !campaignEnd) {
        throw new BadRequestException(
          "Campaign timeline is incomplete. Contact support.",
        );
      }

      const selected = new Date(selectedPostDate);
      if (Number.isNaN(selected.getTime())) {
        throw new BadRequestException("selectedPostDate is invalid");
      }

      if (
        selected < new Date(campaignStart) ||
        selected > new Date(campaignEnd)
      ) {
        throw new BadRequestException(
          "selectedPostDate must be between campaign start and end dates",
        );
      }

      invite.selectedPostDate = selected;
      // Insights (screenshot + metrics) unlock 24h after the posting date
      invite.insightsUnlocksAt = new Date(
        selected.getTime() + 24 * 60 * 60 * 1000,
      );
      invite.acceptedAt = new Date();
      const recipientAny = recipient as any;
      invite.acceptedContact = {
        whatsapp: !!recipientAny?.contact?.whatsapp,
        email: !!recipientAny?.contact?.email,
        call: !!recipientAny?.contact?.call,
      };
      invite.acceptedContactSnapshotAt = new Date();

      const isTierFilteredOpen =
        String(campaign?.campaignMode || "") === "tier_filtered_open";
      const recipientCanUsePlatformRules = recipientRole !== "photographer";
      const lockedPlatform =
        recipientCanUsePlatformRules && !isTierFilteredOpen
          ? String(invite.selectedPlatform || "").trim()
          : "";
      if (
        recipientCanUsePlatformRules &&
        lockedPlatform &&
        selectedPlatform &&
        normalized(lockedPlatform) !== normalized(selectedPlatform)
      ) {
        throw new BadRequestException(
          `This invite is locked to ${lockedPlatform}. Please select content from that platform only.`,
        );
      }
      const effectivePlatform = recipientCanUsePlatformRules
        ? selectedPlatform || lockedPlatform || undefined
        : undefined;

      if (
        recipientCanUsePlatformRules &&
        isTierFilteredOpen &&
        effectivePlatform
      ) {
        const TIER_ORDER = [
          "Starter",
          "Nano",
          "Micro",
          "Mid-Tier",
          "Macro",
          "Mega / Celebrity",
        ];
        const campaignPlatforms: string[] = Array.isArray(campaign?.platforms)
          ? campaign.platforms
          : [];
        const influencerSocials: any[] = Array.isArray(
          (influencer as any)?.socialMedia,
        )
          ? (influencer as any).socialMedia
          : [];

        if (
          campaignPlatforms.length > 0 &&
          !campaignPlatforms.some(
            (platform) =>
              normalized(platform) === normalized(effectivePlatform),
          )
        ) {
          throw new BadRequestException(
            `Invalid platform. This campaign accepts: ${campaignPlatforms.join(", ")}.`,
          );
        }

        const matchingProfile = influencerSocials.find(
          (entry: any) =>
            normalized(entry?.platform || "") === normalized(effectivePlatform),
        );
        if (!matchingProfile) {
          throw new BadRequestException(
            `You don't have ${effectivePlatform} in your profile. Please add it first.`,
          );
        }

        const requiredTier = String(campaign?.minInfluencerTier || "").trim();
        const requiredTierIndex = TIER_ORDER.indexOf(requiredTier);
        if (requiredTier && requiredTierIndex !== -1) {
          const influencerTierIndex = TIER_ORDER.indexOf(
            String(matchingProfile?.tier || "").trim(),
          );
          if (influencerTierIndex !== requiredTierIndex) {
            throw new BadRequestException(
              `This campaign requires exactly ${requiredTier} tier influencers on ${effectivePlatform}.`,
            );
          }
        }
      }

      // Store chosen platform/content type and resolve offered amount.
      if (effectivePlatform) invite.selectedPlatform = effectivePlatform;
      if (selectedContentType) invite.selectedContentType = selectedContentType;
      const isDeliverablePricing = this.isDeliverableBasedPricing(
        campaign,
        recipientRole,
      );

      // Validate content type BEFORE computing payout so the right error fires.
      if (
        isDeliverablePricing &&
        campaign?.socialMedia?.length &&
        !selectedContentType
      ) {
        throw new BadRequestException(
          "Please select the content type you will create before responding.",
        );
      }

      const offeredRupees = isDeliverablePricing
        ? this.resolveDeliverableOfferRupees(
            campaign,
            effectivePlatform,
            selectedContentType,
          )
        : this.toRupeesFromPaise(Number(campaign?.pricePerInfluencer || 0));
      const offeredPaise = isDeliverablePricing
        ? this.toPaiseFromMaybeRupees(offeredRupees)
        : Number(campaign?.pricePerInfluencer || 0);

      if (!offeredPaise || offeredPaise <= 0) {
        throw new BadRequestException(
          "Offered payout is not configured for this invite.",
        );
      }

      if (isRecipientResolvingBrandCounter) {
        const brandCounterRupees = Number(
          invite?.counterOffer?.requestedAmount || 0,
        );
        const brandCounterPaise = Number(
          invite?.counterOffer?.requestedAmountPaise || 0,
        );
        if (!Number.isFinite(brandCounterPaise) || brandCounterPaise <= 0) {
          throw new BadRequestException("Invalid revised counter amount.");
        }
        invite.agreedAmount = brandCounterRupees;
        invite.agreedAmountPaise = brandCounterPaise;
      } else {
        invite.agreedAmount = offeredRupees;
        invite.agreedAmountPaise = offeredPaise;
      }

      if (status === "counter_sent") {
        const requestedRupees = Number(counterAmount || 0);
        if (!Number.isFinite(requestedRupees) || requestedRupees <= 0) {
          throw new BadRequestException(
            "counterAmount must be greater than 0 (rupees).",
          );
        }
        const requestedPaise = this.toPaiseFromMaybeRupees(requestedRupees);
        invite.counterOffer = {
          status: "sent",
          pricingMode: isDeliverablePricing ? "deliverable_based" : "flat",
          selectedPlatform: effectivePlatform || undefined,
          selectedContentType: selectedContentType || undefined,
          offeredAmount: offeredRupees,
          offeredAmountPaise: offeredPaise,
          requestedAmount: requestedRupees,
          requestedAmountPaise: requestedPaise,
          message: String(counterMessage || "").trim() || undefined,
          sentAt: new Date(),
          responderId: String(influencerId || ""),
        };
      } else if (isRecipientResolvingBrandCounter) {
        invite.counterOffer = {
          ...invite.counterOffer,
          status: "accepted",
          resolvedAt: new Date(),
        };
      } else {
        invite.counterOffer = {
          status: "none",
          sentAt: undefined,
          resolvedAt: undefined,
        };
      }

      // Persist confirmed payout details on the influencer profile so admin
      // can prefill the payout popup later. Only update fields the influencer
      // actually provided/edited.
      if (
        recipientRole !== "photographer" &&
        payout &&
        (payout.upiId || payout.mobile || payout.accountHolderName)
      ) {
        const set: any = { "payout.lastConfirmedAt": new Date() };
        const upiId = String(payout.upiId || "").trim();
        const mobile = String(payout.mobile || "").trim();
        const accountHolderName = String(payout.accountHolderName || "").trim();
        if (upiId) set["payout.upiId"] = upiId;
        if (mobile) set["payout.mobile"] = mobile;
        if (accountHolderName)
          set["payout.accountHolderName"] = accountHolderName;
        try {
          if (Object.keys(set).length > 1) {
            await this.influencerModel.findByIdAndUpdate(influencerId, {
              $set: set,
            });
          }
        } catch (err) {
          console.error("Failed to persist recipient payout details:", err);
        }
      }

      // Location/map visibility is payment-confirmation gated. Keep unlock state
      // unchanged on plain acceptance; unlock continues through explicit brand flow.
    }

    if (status === "declined" && isRecipientResolvingBrandCounter) {
      invite.counterOffer = {
        ...invite.counterOffer,
        status: "declined",
        resolvedAt: new Date(),
      };
    }

    invite.status = status;
    const updated = await invite.save();

    // Log acceptance details for observability (platform/content/tier)
    if (status === "accepted") {
      try {
        const recipientRole = this.normalizeRecipientRole(
          invite?.recipientRole,
        );
        const logObj: any = {
          inviteId: invite._id,
          campaignId: invite.campaignId,
          influencerId: invite.influencerId,
          recipientRole,
          selectedPlatform: invite.selectedPlatform || null,
          selectedContentType: invite.selectedContentType || null,
          agreedAmount: invite.agreedAmount || null,
          timestamp: new Date().toISOString(),
        };
        this.logger.log(`Invite accepted: ${JSON.stringify(logObj)}`);
      } catch (e) {
        // Non-fatal — don't block the acceptance flow on logging errors
        console.error("Logging failure for invite accept:", e);
      }
    }

    // Create the tracking link eagerly on acceptance so it exists even if nobody
    // ever opens a dashboard view that would otherwise lazily create it (e.g. once
    // the campaign is completed, no dashboard is being visited).
    if (status === "accepted") {
      this.trackingLinksService
        .getOrCreateForInvite(String(invite._id), String(invite.influencerId), true)
        .catch(() => {
          /* non-critical — e.g. campaign has no promotionUrl configured */
        });
    }

    if (status === "accepted") {
      const acceptedRole = this.normalizeRecipientRole(invite?.recipientRole);
      const campaignForClose: any = await this.campaignModel
        .findById(invite.campaignId)
        .select(
          "maxInfluencers maxPhotographers maxPhotoVideoGraphers maxPhotovideographers maxPhotoVideographers inviteSlots",
        )
        .lean();
      const closeAt = this.getRoleAcceptanceCloseAt(
        campaignForClose,
        acceptedRole,
      );
      await this.withdrawRemainingPendingInvitesForClosedRole(
        invite.campaignId,
        invite._id,
        acceptedRole,
        closeAt,
      );
    }

    // Send notification email to brand on acceptance
    if (status === "accepted") {
      try {
        const sender = await this.resolveSenderProfile(String(invite.brandId));
        const recipient: any = await this.loadRecipientProfile(
          recipientRole,
          influencerId,
        );
        const campaign: any = await this.campaignModel
          .findById(invite.campaignId)
          .select("title")
          .lean();
        // Invite accepted emails are disabled by product request.
        // Push notification to brand
        this.pushService
          .sendToUser(String(invite.brandId), {
            title: "Invite Accepted ✅",
            body: `${recipient?.name || `A ${recipientRole}`} accepted your invite for "${campaign?.title || "your campaign"}"`,
            url: "/campaign-management",
          }, 'campaign')
          .catch(() => {
            /* non-critical */
          });
        this.notificationsService
          .createForUser({
            userId: String(invite.brandId),
            userRole: sender.role,
            title: "Invite Accepted",
            body: `${recipient?.name || `A ${recipientRole}`} accepted your invite for "${campaign?.title || "your campaign"}"`,
            url: "/campaign-management",
          })
          .catch(() => {
            /* non-critical */
          });
      } catch (e) {
        console.error("Failed to send acceptance notification:", e);
      }
    }

    if (status === "counter_sent") {
      try {
        const sender = await this.resolveSenderProfile(String(invite.brandId));
        const requested = Number(invite?.counterOffer?.requestedAmount || 0);
        const selectedLabel = invite?.counterOffer?.selectedContentType
          ? `${invite.counterOffer.selectedPlatform || ""} ${invite.counterOffer.selectedContentType}`.trim()
          : "this collaboration";
        this.pushService
          .sendToUser(String(invite.brandId), {
            title: "Counter offer received",
            body: `Recipient requested ₹${requested.toLocaleString("en-IN")} for ${selectedLabel}.`,
            url: "/campaign-management",
          }, 'campaign')
          .catch(() => {
            /* non-critical */
          });
        this.notificationsService
          .createForUser({
            userId: String(invite.brandId),
            userRole: sender.role,
            title: "Counter offer received",
            body: `Recipient requested ₹${requested.toLocaleString("en-IN")} for ${selectedLabel}.`,
            url: "/campaign-management",
          })
          .catch(() => {
            /* non-critical */
          });
      } catch {
        /* non-critical */
      }
    }

    return updated;
  }

  async respondToCounter(
    inviteId: string,
    requesterId: string,
    action: "accept" | "decline" | "counter",
    note?: string,
    counterAmount?: number,
  ) {
    const invite: any = await this.assertBrandOwnsInvite(inviteId, requesterId);
    if (String(invite?.status || "") !== "counter_sent") {
      throw new BadRequestException(
        "No pending counter offer for this invite.",
      );
    }
    const counter = invite?.counterOffer || {};
    const counterStatus = String(counter?.status || "");
    if (action === "counter") {
      if (counterStatus !== "sent") {
        throw new BadRequestException(
          "A revised counter can only be sent for a newly received counter offer.",
        );
      }
      const revisedRupees = Number(counterAmount || 0);
      if (!Number.isFinite(revisedRupees) || revisedRupees <= 0) {
        throw new BadRequestException(
          "counterAmount must be greater than 0 (rupees).",
        );
      }
      const revisedPaise = this.toPaiseFromMaybeRupees(revisedRupees);
      invite.status = "counter_sent";
      invite.counterOffer = {
        ...counter,
        status: "brand_sent",
        offeredAmount: Number(
          counter?.requestedAmount || counter?.offeredAmount || 0,
        ),
        offeredAmountPaise: Number(
          counter?.requestedAmountPaise || counter?.offeredAmountPaise || 0,
        ),
        requestedAmount: revisedRupees,
        requestedAmountPaise: revisedPaise,
        message: String(note || "").trim() || undefined,
        sentAt: new Date(),
        responderId: String(requesterId || ""),
      };
      const updatedCounter = await invite.save();

      const recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
      const recipientId = String(
        invite?.influencerId || invite?.photographerId || "",
      );
      const msg = `Creator sent a revised offer of ₹${revisedRupees.toLocaleString("en-IN")}. You can accept or decline.`;
      this.pushService
        .sendToUser(recipientId, {
          title: "Revised offer received",
          body: msg,
          url:
            recipientRole === "photographer"
              ? "/campaign-management"
              : "/influencer-dashboard",
        }, 'campaign')
        .catch(() => {
          /* non-critical */
        });
      this.notificationsService
        .createForUser({
          userId: recipientId,
          userRole: recipientRole,
          title: "Revised offer received",
          body: msg,
          url:
            recipientRole === "photographer"
              ? "/campaign-management"
              : "/influencer-dashboard",
        })
        .catch(() => {
          /* non-critical */
        });

      return updatedCounter;
    }

    if (counterStatus !== "sent") {
      throw new BadRequestException("Counter offer is already resolved.");
    }

    if (action === "accept") {
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("status")
        .lean();
      this.assertCampaignLiveForRecipient(campaign, "accept the counter offer");
      this.assertCampaignNotEnded(campaign, "accept the counter offer");
      const recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
      const recipientIdForEligibility = String(
        invite?.influencerId || invite?.photographerId || "",
      );
      await this.profileVerificationService.assertCampaignEligible(
        recipientIdForEligibility,
        recipientRole,
      );
      const requestedAmount = Number(counter?.requestedAmount || 0);
      const requestedAmountPaise = Number(counter?.requestedAmountPaise || 0);
      if (!requestedAmountPaise || requestedAmountPaise <= 0) {
        throw new BadRequestException("Invalid counter amount.");
      }
      invite.agreedAmount = requestedAmount;
      invite.agreedAmountPaise = requestedAmountPaise;
      invite.status = "accepted";
      invite.acceptedAt = invite.acceptedAt || new Date();
      invite.counterOffer = {
        ...counter,
        status: "accepted",
        resolvedAt: new Date(),
        message: String(note || counter?.message || "").trim() || undefined,
      };
    } else {
      invite.status = "pending";
      invite.counterOffer = {
        ...counter,
        status: "declined",
        resolvedAt: new Date(),
        message: String(note || counter?.message || "").trim() || undefined,
      };
    }

    const updated = await invite.save();

    if (action === "accept") {
      this.trackingLinksService
        .getOrCreateForInvite(String(invite._id), String(invite.influencerId), true)
        .catch(() => {
          /* non-critical — e.g. campaign has no promotionUrl configured */
        });
    }

    const recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
    const recipientId = String(
      invite?.influencerId || invite?.photographerId || "",
    );
    const body =
      action === "accept"
        ? "Your counter offer was accepted. Collaboration is now confirmed for payment flow."
        : "Your counter offer was declined. You can accept the original offer from your invite.";
    this.pushService
      .sendToUser(recipientId, {
        title: action === "accept" ? "Counter accepted" : "Counter declined",
        body,
        url:
          recipientRole === "photographer"
            ? "/campaign-management"
            : "/influencer-dashboard",
      }, 'campaign')
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: recipientId,
        userRole: recipientRole,
        title: action === "accept" ? "Counter accepted" : "Counter declined",
        body,
        url:
          recipientRole === "photographer"
            ? "/campaign-management"
            : "/influencer-dashboard",
      })
      .catch(() => {
        /* non-critical */
      });

    return updated;
  }

  async submitAnalytics(
    inviteId: string,
    influencerId: string,
    analytics: { reach?: number; engagement?: number; clicks?: number },
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "accepted") {
      throw new BadRequestException(
        "Can only submit analytics for accepted invites",
      );
    }
    invite.analytics = analytics;
    return invite.save();
  }

  async applyToCampaign(
    influencerId: string,
    campaignId: string,
    selectedPlatform?: string,
  ) {
    const TIER_ORDER = [
      "Starter",
      "Nano",
      "Micro",
      "Mid-Tier",
      "Macro",
      "Mega / Celebrity",
    ];

    const campaign = (await this.campaignModel
      .findById(campaignId)
      .lean()) as any;
    if (!campaign) throw new NotFoundException("Campaign not found");

    if (campaign.campaignMode !== "tier_filtered_open") {
      throw new BadRequestException(
        "This campaign is invite-only. You can respond only when a brand sends you an invite.",
      );
    }

    if (campaign.status !== "active") {
      throw new BadRequestException(
        "This campaign is not currently accepting applications.",
      );
    }

    // Check influencer meets minimum tier requirement
    const influencer = await this.influencerModel.findById(influencerId).lean();
    if (!influencer) throw new NotFoundException("Influencer not found");
    await this.profileVerificationService.assertCampaignEligible(
      influencerId,
      "influencer",
    );

    const sm: any[] = (influencer as any).socialMedia || [];
    const campaignPlatforms: string[] = campaign.platforms || [];
    const normalized = (s: string) => (s || "").toLowerCase().trim();

    // Validate selectedPlatform — if provided, it must be campaign-targeted and present on influencer profile.
    // If not provided, do not auto-select; influencer will choose platform/content in pending step.
    let chosenPlatform: string | null = null;
    if (campaignPlatforms.length > 0) {
      if (selectedPlatform) {
        const isValid = campaignPlatforms.some(
          (p) => normalized(p) === normalized(selectedPlatform),
        );
        if (!isValid) {
          throw new BadRequestException(
            `Invalid platform. This campaign accepts: ${campaignPlatforms.join(", ")}.`,
          );
        }
        const hasPlatform = sm.some(
          (entry) =>
            normalized(entry.platform) === normalized(selectedPlatform),
        );
        if (!hasPlatform) {
          throw new BadRequestException(
            `You don't have ${selectedPlatform} in your profile. Please add it first.`,
          );
        }
        chosenPlatform = selectedPlatform;
      } else {
        const hasAnyCampaignPlatform = sm.some((entry) =>
          campaignPlatforms.some(
            (p) => normalized(p) === normalized(entry.platform),
          ),
        );
        if (!hasAnyCampaignPlatform) {
          throw new BadRequestException(
            `You don't have a qualifying platform for this campaign. Required: ${campaignPlatforms.join(", ")}.`,
          );
        }
      }
    }

    if (campaign.minInfluencerTier) {
      const minIdx = TIER_ORDER.indexOf(campaign.minInfluencerTier);
      // For explicit platform selection, validate tier on that platform.
      // Otherwise validate tier across campaign-targeted platforms (or all socials if no platform restriction).
      const scope = chosenPlatform
        ? sm.filter(
            (entry: any) =>
              normalized(entry.platform) === normalized(chosenPlatform),
          )
        : campaignPlatforms.length > 0
          ? sm.filter((entry: any) =>
              campaignPlatforms.some(
                (p) => normalized(p) === normalized(entry.platform),
              ),
            )
          : sm;
      const hasExactTier =
        minIdx !== -1 &&
        scope.some(
          (entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === minIdx,
        );
      if (minIdx !== -1 && !hasExactTier) {
        const platformLabel = chosenPlatform ? ` on ${chosenPlatform}` : "";
        throw new BadRequestException(
          `This campaign requires exactly ${campaign.minInfluencerTier} tier influencers${platformLabel}.`,
        );
      }
    }

    // Check state/district targeting eligibility (case-insensitive)
    if (campaign.targetState) {
      const infState = ((influencer as any).location?.state ?? "").trim().toLowerCase();
      const targetState = String(campaign.targetState || "").trim().toLowerCase();
      if (infState && infState !== targetState) {
        throw new BadRequestException(
          `This campaign is limited to influencers from ${campaign.targetState}.`,
        );
      }
    }
    if (campaign.targetDistrict) {
      const infDistrict = ((influencer as any).location?.district ?? "").trim().toLowerCase();
      const targetDistrict = String(campaign.targetDistrict || "").trim().toLowerCase();
      if (infDistrict && infDistrict !== targetDistrict) {
        throw new BadRequestException(
          `This campaign is limited to influencers from ${campaign.targetDistrict}, ${campaign.targetState}.`,
        );
      }
    }

    // Check max slots not exceeded
    const influencerCloseAt = this.getRoleAcceptanceCloseAt(
      campaign,
      "influencer",
    );
    const acceptedCount = await this.countAcceptedForRole(
      campaignId,
      "influencer",
    );
    if (influencerCloseAt && acceptedCount >= influencerCloseAt) {
      throw new BadRequestException(
        "This campaign has reached its maximum number of influencers.",
      );
    }

    // Prevent duplicate application
    const existing = await this.inviteModel
      .findOne({ campaignId, influencerId })
      .lean();
    if (existing) {
      throw new BadRequestException(
        "You have already applied to this campaign.",
      );
    }

    // Create pending invite (brand still reviews)
    const invite = await this.inviteModel.create({
      campaignId,
      influencerId,
      brandId: campaign.brandId,
      status: "pending",
      selectedPlatform: chosenPlatform ?? null,
      agreedAmount: this.toRupeesFromPaise(campaign.pricePerInfluencer ?? 0),
      agreedAmountPaise: Number(campaign.pricePerInfluencer || 0),
    });

    // Notify brand
    await this.pushService.sendToUser(String(campaign.brandId), {
      title: "New Campaign Application 📩",
      body: `${(influencer as any).fullName || "An influencer"} applied to your campaign "${campaign.title}".`,
      url: "/brand/campaigns",
    }, 'campaign');
    this.notificationsService
      .createForUser({
        userId: String(campaign.brandId),
        userRole: "brand",
        title: "New Campaign Application",
        body: `${(influencer as any).fullName || "An influencer"} applied to your campaign "${campaign.title}".`,
        url: "/campaign-management",
      })
      .catch(() => {
        /* non-critical */
      });

    return {
      message: "Application submitted. Awaiting brand approval.",
      inviteId: invite._id,
    };
  }

  /* ── Submission Flow ──────────────────────────────────────────────────── */

  async startWork(inviteId: string, influencerId: string) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }

    const status = String(invite.status || "").toLowerCase();
    if (
      ["working", "submitted", "approved", "completed", "disputed"].includes(
        status,
      )
    ) {
      return { success: true, invite };
    }

    if (!["accepted", "payment_confirmed"].includes(status)) {
      throw new BadRequestException(
        `Work can only start after collaboration confirmation. Status was: ${invite.status}`,
      );
    }
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select("status")
      .lean();
    this.assertCampaignLiveForRecipient(campaign, "start work");
    this.assertCampaignNotEnded(campaign, "start work");

    invite.status = "working";
    await invite.save();

    await this.campaignTransactionModel.updateMany(
      { inviteId },
      { $set: { workStatus: "working" } },
    );

    return { success: true, invite };
  }

  async submitPost(
    inviteId: string,
    influencerId: string,
    data: {
      postUrl: string;
      postType?: string;
      captionUsed?: string;
      postScreenshotUrl?: string;
      insightsScreenshotUrl?: string;
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      reachCount?: number;
    },
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (!["accepted", "payment_confirmed", "working", "disputed"].includes(invite.status)) {
      throw new BadRequestException(
        `Can only submit for active invites. Status was: ${invite.status}`,
      );
    }
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select("status postingDeadlineMode")
      .lean();
    this.assertCampaignLiveForRecipient(campaign, "submit work");
    this.assertCampaignNotEnded(campaign, "submit work");
    if (!data.postUrl) throw new BadRequestException("Post URL is required");

    // Late-submission handling: allowed within the campaign's grace window, marked late;
    // blocked entirely once the window (strict or grace) has fully passed.
    let lateInfo = { isLate: false, daysLate: 0 };
    if (invite.selectedPostDate) {
      const deadline = this.computeGraceDeadline(invite, campaign);
      if (Date.now() > deadline.closesAt.getTime()) {
        throw new BadRequestException("Submission window has closed.");
      }
      lateInfo = { isLate: deadline.isLate, daysLate: deadline.daysLate };
    }
    // Screenshot is recommended but optional — influencers can submit without one

    // Insights (screenshot + metrics) are locked until 24h after the committed post date
    const hasInsights =
      data.insightsScreenshotUrl ||
      data.likesCount != null ||
      data.commentsCount != null ||
      data.sharesCount != null ||
      data.viewsCount != null ||
      data.reachCount != null;
    if (hasInsights && invite.insightsUnlocksAt) {
      if (Date.now() < new Date(invite.insightsUnlocksAt).getTime()) {
        const unlockDate = new Date(invite.insightsUnlocksAt).toUTCString();
        throw new BadRequestException(
          `Insights can only be submitted 24 hours after your posting date. Unlocks at: ${unlockDate}`,
        );
      }
    }

    const postPlatform = detectPlatform(data.postUrl);
    const normalizePlatform = (v: string) => {
      const p = String(v || "")
        .toLowerCase()
        .trim();
      if (p === "x") return "twitter";
      return p;
    };
    const normalizeContentType = (v: string) => {
      const t = String(v || "")
        .toLowerCase()
        .trim();
      if (t === "reels") return "reel";
      if (t === "shorts") return "short";
      if (t === "stories") return "story";
      if (t === "post" || t === "image") return "photo";
      return t;
    };

    const acceptedPlatform = normalizePlatform(
      String(invite.selectedPlatform || ""),
    );
    if (
      acceptedPlatform &&
      normalizePlatform(postPlatform) !== acceptedPlatform
    ) {
      throw new BadRequestException(
        `This invite is accepted for ${invite.selectedPlatform}. Please submit only ${invite.selectedPlatform} post URL.`,
      );
    }

    const acceptedContentType = normalizeContentType(
      String(invite.selectedContentType || ""),
    );
    const submittedContentType = normalizeContentType(
      String(data.postType || ""),
    );
    if (
      acceptedContentType &&
      submittedContentType &&
      acceptedContentType !== submittedContentType
    ) {
      throw new BadRequestException(
        `This invite requires ${invite.selectedContentType}. Please submit the agreed content type.`,
      );
    }

    const engagementRate = computeEngagementRate(data);

    // One submission per invite for MVP: once submitted, influencer cannot edit URL/type again —
    // except a single resubmission allowed after the host disputes it, to fix and repost.
    const existing = await this.submissionModel.findOne({ inviteId });
    const canResubmit =
      !!existing &&
      existing.status === "disputed" &&
      (existing.resubmissionCount || 0) === 0;
    if (existing && !canResubmit) {
      throw new BadRequestException(
        "Submission already posted and locked. You cannot change it again.",
      );
    }

    const normalizedSubmissionData = {
      ...data,
      postScreenshotUrl: String(data.postScreenshotUrl || "").trim(),
      insightsScreenshotUrl: String(data.insightsScreenshotUrl || "").trim(),
    };

    let submission: any;
    if (canResubmit) {
      // Update the existing (disputed) submission in place — keep the original dispute
      // fields as context for the host's second review; reset the review-window anchors
      // so the auto-approve cron/timers don't fire based on the stale original submittedAt.
      Object.assign(existing, normalizedSubmissionData, {
        postPlatform,
        engagementRate,
        submittedAt: new Date(),
        reviewedAt: null,
        hostAutoCompleteEnabled: false,
        hostAutoCompleteEnabledAt: null,
        status: "submitted",
        resubmissionCount: (existing.resubmissionCount || 0) + 1,
        isLate: lateInfo.isLate,
        daysLate: lateInfo.daysLate,
      });
      await existing.save();
      submission = existing;
    } else {
      // Create one submission record per invite
      submission = await this.submissionModel.create({
        campaignId: String(invite.campaignId),
        influencerId,
        inviteId,
        ...normalizedSubmissionData,
        postPlatform,
        engagementRate,
        submittedAt: new Date(),
        status: "submitted",
        isLate: lateInfo.isLate,
        daysLate: lateInfo.daysLate,
      });
    }

    // A plain report ("not yet posted") is now moot once the influencer actually submits —
    // auto-resolve it. Scoped to invite.status !== 'disputed' so this never touches the
    // genuine post-dispute resubmission path (that dispute stays open until the host's
    // second review concludes it).
    if (
      invite.reportedIssue?.reportedAt &&
      !invite.reportedIssue?.resolvedAt &&
      invite.status !== "disputed"
    ) {
      const resolvedNow = new Date();
      invite.reportedIssue.resolvedAt = resolvedNow;
      invite.reportedIssue.reason =
        (invite.reportedIssue.reason || "") +
        `\n[system ${resolvedNow.toISOString()}]: Auto-resolved: influencer submitted a post.`;
    }

    // Update invite status to submitted
    invite.status = "submitted";
    await invite.save();
    this.invalidateAttentionCache();

    await this.campaignTransactionModel.updateMany(
      { inviteId },
      { $set: { workStatus: "submitted" } },
    );

    // Notify brand
    // Post submitted emails are disabled by product request.

    const submissionOwner = await this.resolveSenderProfile(
      String(invite.brandId),
    );
    this.pushService
      .sendToUser(String(invite.brandId), {
        title: "Post Submitted",
        body: "An influencer submitted content for your review.",
        url: "/campaign-management",
      }, 'campaign')
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(invite.brandId),
        userRole: submissionOwner.role,
        title: "Post Submitted",
        body: "An influencer submitted content for your review.",
        url: "/campaign-management",
      })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, submission };
  }

  async getSubmissionByInvite(inviteId: string) {
    const submission = await this.submissionModel
      .findOne({ inviteId })
      .populate("influencerId", "name username profileImages")
      .lean();
    return { success: true, submission };
  }

  async getSubmissionsByCampaign(campaignId: string, brandId: string) {
    // Verify brand owns campaign
    const campaign: any = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      const brand = await this.brandModel
        .findById(brandId)
        .select("brandUsername")
        .lean();
      const brandUsername =
        brand && typeof brand === "object" && "brandUsername" in brand
          ? (brand as any).brandUsername
          : undefined;
      if (!brandUsername || String(campaign.brandId) !== brandUsername) {
        throw new BadRequestException("Not your campaign");
      }
    }
    const campaignIdAsString = String(campaignId);
    const query: any = {
      $or: [{ campaignId: campaignIdAsString }, { campaignId }],
    };
    if (Types.ObjectId.isValid(campaignIdAsString)) {
      query.$or.push({ campaignId: new Types.ObjectId(campaignIdAsString) });
    }

    const submissions = await this.submissionModel
      .find(query)
      .populate("influencerId", "name username profileImages socialMedia")
      .lean();
    return { success: true, submissions };
  }

  async setSubmissionAutoComplete(
    inviteId: string,
    brandId: string,
    enabled: boolean,
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");

    const campaign: any = await this.campaignModel.findById(invite.campaignId);
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      const brand = await this.brandModel.findById(brandId).lean();
      const brandUsername =
        brand && typeof brand === "object" && "brandUsername" in brand
          ? (brand as any).brandUsername
          : undefined;
      if (!brandUsername || String(campaign.brandId) !== brandUsername) {
        throw new BadRequestException("Not your campaign");
      }
    }

    const submission = await this.submissionModel.findOne({ inviteId });
    if (!submission) throw new NotFoundException("Submission not found");
    if (String(submission.status || "").toLowerCase() !== "submitted") {
      throw new BadRequestException(
        "Auto-complete can only be changed while the post is under review.",
      );
    }

    submission.hostAutoCompleteEnabled = !!enabled;
    submission.hostAutoCompleteEnabledAt = enabled ? new Date() : null;
    await submission.save();

    const autoCompleteAt = submission.hostAutoCompleteEnabled
      ? this.getHostAutoCompleteAt(submission, await this.getSubmissionApprovalWaitHours())
      : null;

    return {
      success: true,
      submission,
      autoCompleteAt,
    };
  }

  async reviewSubmission(
    inviteId: string,
    brandId: string,
    action: "approve" | "dispute",
    feedback?: string,
    disputeReason?: string,
    disputeIssueReason?: string,
    disputeEvidenceUrl?: string,
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    // Verify brand owns campaign
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      const brand = await this.brandModel
        .findById(brandId)
        .select("brandUsername")
        .lean();
      const bUsername =
        brand && typeof brand === "object" && "brandUsername" in brand
          ? (brand as any).brandUsername
          : undefined;
      if (!bUsername || String(campaign.brandId) !== bUsername) {
        throw new BadRequestException("Not your campaign");
      }
    }

    const submission = await this.submissionModel.findOne({ inviteId });
    if (!submission) throw new NotFoundException("Submission not found");

    const now = new Date();
    // A host can flag an issue at any point during the review window — only
    // "approve" (Mark Completed) is gated behind the review-wait period.
    if (action === "approve") {
      const waitHours = await this.getSubmissionApprovalWaitHours();
      const submittedAtRaw =
        submission.submittedAt || submission.updatedAt || submission.createdAt;

      if (!submittedAtRaw) {
        throw new BadRequestException(
          `Review period active. Completion confirmation unlocks in ${waitHours} hours after influencer submission.`,
        );
      }

      const submittedAt = new Date(submittedAtRaw);
      const unlockAt = new Date(
        submittedAt.getTime() + waitHours * 60 * 60 * 1000,
      );
      if (
        Number.isNaN(submittedAt.getTime()) ||
        now.getTime() < unlockAt.getTime()
      ) {
        throw new BadRequestException(
          `Review period active. Completion confirmation unlocks ${waitHours} hours after submission. Unlocks at: ${unlockAt.toUTCString()}`,
        );
      }
      if (
        submission.hostAutoCompleteEnabled &&
        now.getTime() >= unlockAt.getTime()
      ) {
        await this.autoCompleteSubmission(submission, invite, now);
        return { success: true, submission, autoCompleted: true };
      }
    }

    if (action === "approve") {
      submission.status = "approved";
      submission.brandFeedback = feedback || "";
      submission.reviewedAt = now;
      await submission.save();

      // Approving closes out any dangling plain report too — otherwise it'd be left
      // permanently open on a now-completed invite with nobody able to act on it.
      if (
        invite.reportedIssue?.reportedAt &&
        !invite.reportedIssue?.resolvedAt &&
        invite.status !== "disputed"
      ) {
        invite.reportedIssue.resolvedAt = now;
        invite.reportedIssue.reason =
          (invite.reportedIssue.reason || "") +
          `\n[system ${now.toISOString()}]: Auto-resolved: host approved the submission.`;
      }

      invite.status = "completed";
      invite.completedAt = new Date();
      await invite.save();
      this.invalidateAttentionCache();

      const txs = await this.campaignTransactionModel.find({ inviteId });
      for (const tx of txs) {
        tx.workStatus = "approved";
        tx.payoutStatus =
          tx.collectionStatus === "verified" ? "processing" : "pending";
        await tx.save();
      }

      // Notify influencer
      try {
        // Post approved emails are disabled by product request.
        // Push notification — payout now processing
        this.pushService
          .sendToUser(String(invite.influencerId), {
            title: "Post Approved! 🎉",
            body: `Your post for "${campaign.title || "the campaign"}" was approved. Payout is being processed.`,
            url: "/influencer-dashboard",
          }, 'campaign')
          .catch(() => {
            /* non-critical */
          });
        this.notificationsService
          .createForUser({
            userId: String(invite.influencerId),
            userRole: "influencer",
            title: "Post Approved",
            body: `Your post for "${campaign.title || "the campaign"}" was approved.`,
            url: "/influencer-dashboard",
          })
          .catch(() => {
            /* non-critical */
          });
      } catch (e) {
        console.error("Failed to send approval notification:", e);
      }
    } else {
      // Only one resubmission is allowed (see submitPost). A second dispute after that
      // resubmission is a "final rejection" — auto-escalate straight to admin instead of
      // reopening the influencer's 12h respond-or-resubmit window.
      const isFinalRejection = (submission.resubmissionCount || 0) >= 1;

      let issueReason = "";
      let issueDescription = "";
      let evidenceUrl = "";
      if (isFinalRejection) {
        issueReason = String(disputeIssueReason || "").trim();
        issueDescription = String(feedback || disputeReason || "Resubmission rejected").trim();
        evidenceUrl = String(disputeEvidenceUrl || "").trim();
      } else {
        const allowedIssueReasons = new Set([
          "Missing hashtag",
          "Missing mention",
          "Wrong platform",
          "Wrong content type",
          "Content removed",
          "Wrong account",
          "Missed posting deadline",
          "Other",
        ]);
        issueReason = String(disputeIssueReason || "").trim();
        issueDescription = String(disputeReason || "").trim();
        evidenceUrl = String(disputeEvidenceUrl || "").trim();
        if (!allowedIssueReasons.has(issueReason)) {
          throw new BadRequestException("Issue reason is required");
        }
        if (issueDescription.length < 20) {
          throw new BadRequestException(
            "Issue description must be at least 20 characters",
          );
        }
      }

      submission.status = "disputed";
      submission.disputeIssueReason = issueReason;
      submission.disputeReason = issueDescription;
      submission.disputeEvidenceUrl = evidenceUrl;
      submission.brandFeedback = feedback || "";
      submission.reviewedAt = now;
      await submission.save();

      invite.status = "disputed";
      // Mirror the dispute onto `reportedIssue` too, so this flow lines up with the plain
      // "report an issue" flow for admin listing/resolving (both key off reportedIssue).
      invite.reportedIssue = {
        reason: issueReason ? `${issueReason} — ${issueDescription}` : issueDescription,
        reportedAt: now,
        // Final rejections skip the influencer's response window entirely — straight to admin.
        adminReviewRequestedAt: isFinalRejection ? now : undefined,
      };
      await invite.save();

      // Freeze the payout — admin must resolve before money moves.
      // workStatus: 'disputed' signals the issue; payoutStatus: 'frozen' holds funds.
      await this.campaignTransactionModel.updateMany(
        { inviteId },
        {
          $set: {
            workStatus: "disputed",
            payoutStatus: "frozen",
            disputeStatus: "open",
            disputeIssueReason: issueReason,
            disputeReason: issueDescription,
            disputeEvidenceUrl: evidenceUrl,
            disputedByRole: "brand",
            disputedAt: new Date(),
          },
        },
      );

      this.pushService
        .sendToUser(String(invite.influencerId), {
          title: "Submission Disputed",
          body: `Your submission for "${campaign.title || "the campaign"}" was marked disputed by brand.`,
          url: "/influencer-dashboard",
        }, 'campaign')
        .catch(() => {
          /* non-critical */
        });
      this.notificationsService
        .createForUser({
          userId: String(invite.influencerId),
          userRole: "influencer",
          title: "Submission Disputed",
          body: `Your submission for "${campaign.title || "the campaign"}" was marked disputed by brand.`,
          url: "/influencer-dashboard",
        })
        .catch(() => {
          /* non-critical */
        });
    }

    return { success: true, submission };
  }

  async updateSubmissionStats(
    inviteId: string,
    influencerId: string,
    stats: {
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      reachCount?: number;
      insightsScreenshotUrl?: string;
    },
  ) {
    const invite = (await this.inviteModel.findById(inviteId).lean()) as any;
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    const submission = await this.submissionModel.findOne({ inviteId });
    if (!submission) throw new NotFoundException("Submission not found");

    Object.assign(submission, stats);
    submission.engagementRate = computeEngagementRate({
      ...submission.toObject(),
      ...stats,
    });
    await submission.save();
    return { success: true, submission };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin oversight queue (disputed invites)
  // ─────────────────────────────────────────────────────────────────────────

  /** Admin: list disputed invites (open by default; pass status='all' or 'resolved'). */
  async adminListDisputes(opts: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    let filter: any = {};
    if (opts.status === "resolved") {
      filter["reportedIssue.resolvedAt"] = { $ne: null };
    } else if (opts.status === "all") {
      filter["reportedIssue.reportedAt"] = { $ne: null };
    } else {
      // default: open — reportedIssue-driven, not invite.status-driven, so a plain
      // "report" (which no longer changes invite.status) still shows up here.
      filter = this.openReportFilter();
    }

    const rawInvites = await this.inviteModel
      .find(filter)
      .sort({ "reportedIssue.reportedAt": -1, updatedAt: -1 })
      .limit(limit)
      .lean();

    if (!rawInvites.length) return { invites: [] };

    const invites = await this.attachLatestSubmissions(rawInvites);

    const campaignIds = [
      ...new Set(invites.map((i) => String(i.campaignId)).filter(Boolean)),
    ];
    const brandIds = [
      ...new Set(invites.map((i) => String(i.brandId)).filter(Boolean)),
    ];
    const influencerIds = [
      ...new Set(invites.map((i) => String(i.influencerId)).filter(Boolean)),
    ];

    const [campaigns, brands, photographers, influencers] = await Promise.all([
      this.campaignModel
        .find({ _id: { $in: campaignIds } })
        .select("title campaignType ownerType campaignNumber")
        .lean(),
      this.brandModel
        .find({ _id: { $in: brandIds } })
        .select("brandName email")
        .lean(),
      this.photographerModel
        .find({ _id: { $in: brandIds } })
        .select("name email")
        .lean(),
      this.influencerModel
        .find({ _id: { $in: influencerIds } })
        .select("name email")
        .lean(),
    ]);

    const cMap = new Map(campaigns.map((c: any) => [String(c._id), c]));
    const bMap = new Map(
      brands.map((b: any) => [String(b._id), { _id: b._id, name: b.brandName, email: b.email }]),
    );
    const pMap = new Map(photographers.map((p: any) => [String(p._id), p]));
    const iMap = new Map(influencers.map((i: any) => [String(i._id), i]));

    return {
      invites: invites.map((inv: any) => ({
        ...inv,
        campaign: cMap.get(String(inv.campaignId)) || null,
        brand:
          bMap.get(String(inv.brandId)) ||
          pMap.get(String(inv.brandId)) ||
          null,
        influencer: iMap.get(String(inv.influencerId)) || null,
      })),
    };
  }

  /**
   * The single place that resolves a dispute's outcome, keeping the invite, its submission,
   * and every CampaignTransaction row consistent. Used by admin resolution, influencer-initiated
   * withdrawal, and the auto-cancel cron — so no matter who/what resolves a dispute, all three
   * documents move together (previously only the invite was ever updated).
   */
  private async finalizeDisputeOutcome(
    inviteId: string,
    outcome: "pay_influencer" | "refund_host",
    opts: { resolvedBy: "admin" | "influencer" | "system"; note?: string } = {
      resolvedBy: "admin",
    },
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    // Idempotent/race-safe: if another call already resolved this (e.g. the cron and an
    // influencer action landing at the same time), no-op rather than double-resolving.
    // Also accepts a plain report-only invite (status never changed, but it has an open
    // reportedIssue) — admin can resolve those via the same "completed"/"withdrawn" buttons.
    const hasOpenReport =
      !!invite.reportedIssue?.reportedAt && !invite.reportedIssue?.resolvedAt;
    if (invite.status !== "disputed" && !hasOpenReport) {
      return { success: true, status: invite.status, skipped: true };
    }

    const now = new Date();
    invite.status = outcome === "pay_influencer" ? "completed" : "withdrawn";
    if (outcome === "pay_influencer") {
      invite.completedAt = now;
    } else if (!invite.withdrawnAt) {
      invite.withdrawnAt = now;
    }
    if (!invite.reportedIssue) {
      invite.reportedIssue = { reason: "", reportedAt: invite.updatedAt || now };
    }
    invite.reportedIssue.resolvedAt = now;
    if (opts.note) {
      invite.reportedIssue.reason =
        (invite.reportedIssue.reason || "") +
        `\n[${opts.resolvedBy} ${now.toISOString()}]: ${opts.note}`;
    }
    invite.updatedAt = now;
    await invite.save();

    const submission = await this.submissionModel.findOne({ inviteId });
    if (submission) {
      submission.status = outcome === "pay_influencer" ? "approved" : "rejected";
      submission.reviewedAt = now;
      await submission.save();
    }

    // Guard against ever downgrading a transaction that's already been paid out via the
    // separate payments-payouts dispute-resolution surface.
    await this.campaignTransactionModel.updateMany(
      { inviteId, payoutStatus: { $ne: "paid" } },
      {
        $set: {
          payoutStatus: outcome === "pay_influencer" ? "processing" : "skipped",
          workStatus: outcome === "pay_influencer" ? "approved" : "disputed",
          disputeStatus: "resolved",
          resolveOutcome:
            outcome === "pay_influencer" ? "release_to_influencer" : "refund_to_brand",
          resolvedAt: now,
        },
      },
    );

    this.invalidateAttentionCache();

    const title = outcome === "pay_influencer" ? "Dispute Resolved — Payout Released" : "Dispute Resolved — Participation Cancelled";
    const body =
      outcome === "pay_influencer"
        ? "Your dispute was resolved in your favor. Payout is being processed."
        : "This collaboration has been cancelled. No payout will be made for this submission.";
    this.pushService
      .sendToUser(String(invite.influencerId), { title, body, url: "/influencer-dashboard" }, "campaign")
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({ userId: String(invite.influencerId), userRole: "influencer", title, body, url: "/influencer-dashboard" })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, status: invite.status };
  }

  /** Admin: mark a dispute resolved with optional note + outcome status. */
  async adminResolveDispute(
    inviteId: string,
    body: {
      outcome?: "completed" | "withdrawn" | "disputed";
      note?: string;
    } = {},
  ) {
    if (body.outcome === "completed") {
      return this.finalizeDisputeOutcome(inviteId, "pay_influencer", {
        resolvedBy: "admin",
        note: body.note,
      });
    }
    if (body.outcome === "withdrawn") {
      return this.finalizeDisputeOutcome(inviteId, "refund_host", {
        resolvedBy: "admin",
        note: body.note,
      });
    }

    // outcome === 'disputed' (close-without-outcome): pure invite-side note append, no
    // payout/submission change — the dispute stays open pending a real decision later.
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    // Some disputes predate mirroring onto `reportedIssue` (e.g. ones raised via the
    // submission-review dispute flow) — fall back to the invite's own disputed status.
    if (!invite.reportedIssue?.reportedAt && invite.status !== "disputed") {
      throw new BadRequestException("Invite has no reported issue.");
    }
    if (!invite.reportedIssue) {
      invite.reportedIssue = { reason: "", reportedAt: invite.updatedAt || new Date() };
    }
    // Matches the pre-refactor behavior: "Close (keep disputed)" removes it from the open
    // queue (resolvedAt set) without deciding a payout outcome — status stays 'disputed'.
    invite.reportedIssue.resolvedAt = new Date();
    if (body.note) {
      invite.reportedIssue.reason =
        (invite.reportedIssue.reason || "") +
        `\n[admin ${new Date().toISOString()}]: ${body.note}`;
    }
    invite.updatedAt = new Date();
    await invite.save();
    return { success: true, status: invite.status };
  }

  /** Admin: bulk-resolve multiple disputes with the same outcome/note. */
  async adminBulkResolveDisputes(
    inviteIds: string[],
    body: {
      outcome?: "completed" | "withdrawn" | "disputed";
      note?: string;
    } = {},
  ): Promise<{ success: boolean; resolved: number; skipped: number }> {
    if (!Array.isArray(inviteIds) || inviteIds.length === 0) {
      return { success: true, resolved: 0, skipped: 0 };
    }
    let resolved = 0;
    let skipped = 0;
    for (const id of inviteIds) {
      try {
        await this.adminResolveDispute(id, body);
        resolved += 1;
      } catch {
        skipped += 1;
      }
    }
    this.invalidateAttentionCache();
    return { success: true, resolved, skipped };
  }

  /** Influencer: bail out of a disputed collab. No payment, host is marked refunded. No admin needed. */
  async withdrawFromDispute(inviteId: string, influencerId: string) {
    const invite = (await this.inviteModel.findById(inviteId).lean()) as any;
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "disputed") {
      throw new BadRequestException("This invite is not currently disputed.");
    }
    return this.finalizeDisputeOutcome(inviteId, "refund_host", { resolvedBy: "influencer" });
  }

  /** Influencer: contest the dispute itself — escalates to admin and pauses the auto-cancel timer. */
  async requestAdminReviewForDispute(inviteId: string, influencerId: string) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "disputed") {
      throw new BadRequestException("This invite is not currently disputed.");
    }
    if (!invite.reportedIssue) {
      invite.reportedIssue = { reason: "", reportedAt: new Date() };
    }
    invite.reportedIssue.adminReviewRequestedAt = new Date();
    invite.updatedAt = new Date();
    await invite.save();
    this.invalidateAttentionCache();
    return { success: true, status: invite.status };
  }

  /** Auto-cancel disputes the influencer never responded to within the configured window. */
  async autoCancelExpiredDisputes(): Promise<{ success: boolean; autoCancelledCount: number }> {
    const waitHours = await this.getDisputeResponseWaitHours();
    const cutoff = new Date(Date.now() - waitHours * 60 * 60 * 1000);

    const candidates = await this.inviteModel
      .find({
        status: "disputed",
        "reportedIssue.resolvedAt": { $in: [null, undefined] },
        "reportedIssue.adminReviewRequestedAt": { $in: [null, undefined] },
        "reportedIssue.reportedAt": { $lte: cutoff },
      })
      .select("_id")
      .lean();

    let autoCancelledCount = 0;
    for (const candidate of candidates) {
      // Re-fetch and re-verify per item — protects against a withdraw/admin-review-request
      // call landing between the bulk find above and this loop iteration.
      const invite = await this.inviteModel.findById(candidate._id);
      if (!invite) continue;
      if (invite.status !== "disputed") continue;
      if (invite.reportedIssue?.resolvedAt) continue;
      if (invite.reportedIssue?.adminReviewRequestedAt) continue;
      const reportedAt = invite.reportedIssue?.reportedAt;
      if (!reportedAt || new Date(reportedAt).getTime() > cutoff.getTime()) continue;

      await this.finalizeDisputeOutcome(String(invite._id), "refund_host", {
        resolvedBy: "system",
        note: `Auto-cancelled: no response within ${waitHours} hours.`,
      });
      autoCancelledCount += 1;
    }

    return { success: true, autoCancelledCount };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async autoCancelExpiredDisputesCron() {
    try {
      await this.autoCancelExpiredDisputes();
    } catch (e) {
      console.error("autoCancelExpiredDisputesCron failed:", e);
    }
  }

  /**
   * Closes out an invite that never got a submission — same "no real payout" convention as
   * `finalizeDisputeOutcome`'s refund_host outcome, but for invites that were never disputed
   * (source status is accepted/payment_confirmed/working, not disputed).
   */
  async expireUnsubmittedInvite(inviteId: string, reason: string) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) return { success: true, skipped: true };
    // Race guard: someone may have just submitted, disputed, or otherwise moved this invite
    // forward between when it was selected as a candidate and now.
    if (!["accepted", "payment_confirmed", "working"].includes(invite.status)) {
      return { success: true, status: invite.status, skipped: true };
    }
    // An open host report (e.g. "not yet posted") blocks auto-expiry — it needs a human
    // decision via the admin Disputes page, not a silent automatic withdrawal.
    if (invite.reportedIssue?.reportedAt && !invite.reportedIssue?.resolvedAt) {
      return { success: true, status: invite.status, skipped: true };
    }

    const now = new Date();
    invite.status = "withdrawn";
    if (!invite.withdrawnAt) invite.withdrawnAt = now;
    invite.withdrawnReason = reason;
    invite.updatedAt = now;
    await invite.save();

    await this.campaignTransactionModel.updateMany(
      { inviteId, payoutStatus: { $ne: "paid" } },
      {
        $set: {
          payoutStatus: "skipped",
          workStatus: "disputed",
          disputeStatus: "resolved",
          resolveOutcome: "refund_to_brand",
          resolvedAt: now,
        },
      },
    );

    this.invalidateAttentionCache();

    const title = "Participation Closed";
    const body = `${reason} No payout will be made for this collaboration.`;
    this.pushService
      .sendToUser(String(invite.influencerId), { title, body, url: "/influencer-dashboard" }, "campaign")
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({ userId: String(invite.influencerId), userRole: "influencer", title, body, url: "/influencer-dashboard" })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, status: invite.status };
  }

  /** Closes out every not-yet-submitted invite for a campaign — called when a host ends it. */
  async expireUnsubmittedInvitesForCampaign(campaignId: string, reason: string) {
    const candidates = await this.inviteModel
      .find({
        campaignId: { $in: [campaignId, String(campaignId)] },
        status: { $in: ["accepted", "payment_confirmed", "working"] },
      })
      .select("_id")
      .lean();
    for (const candidate of candidates) {
      await this.expireUnsubmittedInvite(String(candidate._id), reason);
    }
    return { success: true, expiredCount: candidates.length };
  }

  /** Auto-expire invites whose posting deadline (+ any grace period) passed with no submission. */
  async autoExpireUnsubmittedInvites(): Promise<{ success: boolean; autoExpiredCount: number }> {
    const candidates = await this.inviteModel
      .find({
        status: { $in: ["accepted", "payment_confirmed", "working"] },
        selectedPostDate: { $ne: null },
        $nor: [this.openReportFilter()],
      })
      .select("_id campaignId")
      .lean();

    let autoExpiredCount = 0;
    for (const candidate of candidates) {
      // Re-fetch invite + campaign fresh — protects against a submission/dispute/campaign-end
      // landing between the bulk find above and this loop iteration.
      const invite = await this.inviteModel.findById(candidate._id);
      if (!invite) continue;
      if (!["accepted", "payment_confirmed", "working"].includes(invite.status)) continue;
      if (!invite.selectedPostDate) continue;
      if (invite.reportedIssue?.reportedAt && !invite.reportedIssue?.resolvedAt) continue;
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("postingDeadlineMode")
        .lean();
      if (!campaign) continue;
      const deadline = this.computeGraceDeadline(invite, campaign);
      if (Date.now() <= deadline.closesAt.getTime()) continue;

      await this.expireUnsubmittedInvite(
        String(invite._id),
        "Posting deadline and grace period expired with no submission.",
      );
      autoExpiredCount += 1;
    }

    return { success: true, autoExpiredCount };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async autoExpireUnsubmittedInvitesCron() {
    try {
      await this.autoExpireUnsubmittedInvites();
    } catch (e) {
      console.error("autoExpireUnsubmittedInvitesCron failed:", e);
    }
  }

  /** Admin: lightweight count of open disputes (for nav badges). */
  async adminCountOpenDisputes(): Promise<{ count: number }> {
    const cacheKey = "admin:disputes:count";
    const cached = this.getCachedAttention<{ count: number }>(cacheKey);
    if (cached) return cached;
    const count = await this.inviteModel.countDocuments(this.openReportFilter());
    const result = { count };
    this.setCachedAttention(cacheKey, result);
    return result;
  }

  /**
   * Brand: counts of invites that need brand attention.
   *  - disputed: status='disputed' (and unresolved)
   *  - overdue: dueDate < now, status not terminal/disputed
   *  - awaitingFulfillment: product invite, productFulfillment.status='pending' and status='accepted'
   */
  async getBrandAttentionCounts(brandId: string): Promise<{
    disputed: number;
    overdue: number;
    awaitingFulfillment: number;
  }> {
    const cacheKey = `brand:attention:${brandId}`;
    const cached = this.getCachedAttention<{
      disputed: number;
      overdue: number;
      awaitingFulfillment: number;
    }>(cacheKey);
    if (cached) return cached;
    const now = new Date();
    const brandFilter = { brandId: String(brandId) };
    const [disputed, overdue, awaitingFulfillment] = await Promise.all([
      this.inviteModel.countDocuments({
        ...brandFilter,
        ...this.openReportFilter(),
      }),
      this.inviteModel.countDocuments({
        ...brandFilter,
        dueDate: { $lt: now, $ne: null },
        status: { $nin: ["completed", "withdrawn", "disputed", "rejected"] },
        // Keep mutually exclusive with the "disputed" count above — a reported invite
        // no longer necessarily has status:'disputed', so exclude it explicitly.
        $nor: [this.openReportFilter()],
      }),
      this.inviteModel.countDocuments({
        ...brandFilter,
        status: "accepted",
        "productFulfillment.status": "pending",
      }),
    ]);
    const result = { disputed, overdue, awaitingFulfillment };
    this.setCachedAttention(cacheKey, result);
    return result;
  }

  /**
   * Influencer: counts of items needing the influencer's attention.
   *  - pendingInvites: status='pending'
   *  - overdueDeliverables: dueDate < now, status='accepted'
   *  - disputedAgainstMe: status='disputed' with unresolved reportedIssue
   */
  async getInfluencerAttentionCounts(influencerId: string): Promise<{
    pendingInvites: number;
    overdueDeliverables: number;
    disputedAgainstMe: number;
  }> {
    const cacheKey = `influencer:attention:${influencerId}`;
    const cached = this.getCachedAttention<{
      pendingInvites: number;
      overdueDeliverables: number;
      disputedAgainstMe: number;
    }>(cacheKey);
    if (cached) return cached;
    const now = new Date();
    const idFilter = { influencerId: String(influencerId) };
    const [pendingInvites, overdueDeliverables, disputedAgainstMe] =
      await Promise.all([
        this.inviteModel.countDocuments({ ...idFilter, status: "pending" }),
        this.inviteModel.countDocuments({
          ...idFilter,
          status: "accepted",
          dueDate: { $lt: now, $ne: null },
          // Keep mutually exclusive with disputedAgainstMe below.
          $nor: [this.openReportFilter()],
        }),
        this.inviteModel.countDocuments({
          ...idFilter,
          ...this.openReportFilter(),
        }),
      ]);
    const result = { pendingInvites, overdueDeliverables, disputedAgainstMe };
    this.setCachedAttention(cacheKey, result);
    return result;
  }
}
