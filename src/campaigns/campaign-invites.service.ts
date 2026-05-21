import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import { PlansService } from "../plans/plans.service";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";

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
    private readonly plansService: PlansService,
    private readonly pushService: PushService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private normalizeRecipientRole(role: any): "influencer" | "photographer" {
    return String(role || "influencer").trim().toLowerCase() === "photographer"
      ? "photographer"
      : "influencer";
  }

  private getRecipientModel(role: "influencer" | "photographer") {
    return role === "photographer" ? this.photographerModel : this.influencerModel;
  }

  private async loadRecipientProfile(
    role: "influencer" | "photographer",
    recipientId: string,
  ) {
    return this.getRecipientModel(role)
      .findById(recipientId)
      .select(
        "name email phoneNumber username profileImages socialMedia location isPremium premiumEnd createdAt premiumStart",
      )
      .lean();
  }

  private async attachRecipientProfile(invite: any) {
    if (!invite?.influencerId) {
      return invite;
    }
    const role = this.normalizeRecipientRole(invite?.recipientRole);
    const recipient = await this.loadRecipientProfile(
      role,
      String(invite.influencerId),
    );
    if (!recipient) {
      return invite;
    }
    if (!invite?.unlocked) {
      const safeRecipient = recipient as Record<string, any>;
      const { email: _e, phoneNumber: _p, ...redactedRecipient } = safeRecipient;
      return { ...invite, recipientRole: role, influencerId: redactedRecipient };
    }
    return { ...invite, recipientRole: role, influencerId: recipient };
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
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const staleSubmissions = await this.submissionModel
      .find({ status: "submitted", submittedAt: { $lte: cutoff } })
      .lean();

    let autoApprovedCount = 0;

    for (const stale of staleSubmissions) {
      const submission = await this.submissionModel.findById(stale._id);
      if (!submission || submission.status !== "submitted") continue;

      const invite = await this.inviteModel.findById(submission.inviteId);
      if (!invite) continue;

      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("title")
        .lean();

      submission.status = "approved";
      submission.brandFeedback =
        submission.brandFeedback ||
        "Auto-approved after 48h without brand review.";
      submission.reviewedAt = new Date();
      await submission.save();

      invite.status = "completed";
      await invite.save();

      const txs = await this.campaignTransactionModel.find({
        inviteId: invite._id,
      });
      for (const tx of txs) {
        tx.workStatus = "approved";
        tx.payoutStatus =
          tx.collectionStatus === "verified" ? "processing" : "pending";
        await tx.save();
      }

      try {
        const influencer: any = await this.influencerModel
          .findById(invite.influencerId)
          .select("email name")
          .lean();
        if (influencer?.email) {
          await sendAppEmail({
            to: influencer.email,
            subject: "Campaign auto-approved after 48h",
            text: `Hi ${influencer.name || ""},\n\nYour submission for \\"${campaign?.title || "campaign"}\\" was auto-approved after 48 hours with no brand review. Payout is now queued for processing.`,
          });
        }
      } catch (e) {
        console.error("Failed to send auto-approval email:", e);
      }

      autoApprovedCount++;
    }

    return {
      success: true,
      autoApprovedCount,
    };
  }

  async create(brandId: string, data: any) {
    const campaign: any = await this.campaignModel
      .findById(data.campaignId)
      .lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    // Allow if campaign.brandId matches the user's ObjectId OR their brandUsername (string)
    if (String(campaign.brandId) !== brandId) {
      const brand = await this.brandModel
        .findById(brandId)
        .select("brandUsername")
        .lean();
      const brandUsername =
        brand && typeof brand === "object" && "brandUsername" in brand
          ? brand.brandUsername
          : undefined;
      if (!brandUsername || String(campaign.brandId) !== brandUsername) {
        throw new BadRequestException("Not your campaign");
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
    // Enforce invite limits for brands (admin-manageable)
    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const maxInvitesPerCampaign =
      caps.limits.find((l: any) => l.key === "maxInvitesPerCampaign")?.value ??
      5;
    const maxInvitesPerMonthEntry = caps.limits.find(
      (l: any) => l.key === "maxInvitesPerMonth",
    );
    // Count invites for this campaign
    const inviteCount = await this.inviteModel.countDocuments({
      campaignId: data.campaignId,
    });
    const maxInfluencers = Number(campaign?.maxInfluencers || 0);
    if (maxInfluencers > 0 && inviteCount >= maxInfluencers) {
      throw new BadRequestException(
        `Campaign limit reached: max ${maxInfluencers} influencers can be invited.`,
      );
    }

    const acceptanceCloseAt = Number(campaign?.maxInfluencers || 0);
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
      const acceptedCount = await this.inviteModel.countDocuments({
        campaignId: data.campaignId,
        status: {
          $in: [
            "accepted",
            "payment_confirmed",
            "working",
            "submitted",
            "completed",
            "approved",
          ],
        },
      });
      if (acceptedCount >= acceptanceCloseAt) {
        throw new BadRequestException(
          `Campaign acceptance is closed (${acceptedCount}/${acceptanceCloseAt} reached).`,
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
      const brandDoc = await this.brandModel
        .findById(brandId)
        .select("createdAt premiumStart premiumEnd isPremium")
        .lean();
      const cycleStart = this.computePlanCycleStart(brandDoc);
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
    if (recipientDoc) {
      const recipientMonthlyCap =
        recipientCaps.limits.find(
          (l: any) => l.key === "maxInvitesPerCampaign",
        )?.value ?? -1;
      if (recipientMonthlyCap !== -1) {
        const recipientCycleStart = this.computePlanCycleStart(recipientDoc);
        const recipientMonthCount = await this.inviteModel.countDocuments({
          influencerId: recipientId,
          recipientRole,
          createdAt: { $gte: recipientCycleStart },
        });
        if (recipientMonthCount >= recipientMonthlyCap) {
          throw new BadRequestException(
            `This ${recipientRole} has reached their monthly invite limit (${recipientMonthlyCap}). Try again after their next cycle.`,
          );
        }
      }
    }
    const invite = new this.inviteModel({
      ...data,
      brandId,
      influencerId: recipientId,
      recipientRole,
    });
    const saved = await invite.save();

    // Send notification email to recipient
    try {
      const recipient: any = await this.loadRecipientProfile(
        recipientRole,
        recipientId,
      );
      const brand: any = await this.brandModel
        .findById(brandId)
        .select("brandName")
        .lean();
      if (recipient?.email) {
        const text = `Hi ${recipient.name || ""},\n\nYou have a new campaign invite from ${brand?.brandName || "a brand"} for "${campaign.title}".\nLog in to TrendStarz to respond.\n`;
        await sendAppEmail({
          to: recipient.email,
          subject: "New Campaign Invite",
          text,
        });
      }
      // Push notification to recipient
      this.pushService.sendToUser(String(recipientId), {
        title: "New Campaign Invite 🎉",
        body: `${brand?.brandName || "A brand"} invited you to "${campaign.title}"`,
        url: recipientRole === "photographer" ? "/photographer-dashboard" : "/influencer-dashboard",
      }).catch(() => { /* non-critical */ });
      this.notificationsService
        .createForUser({
          userId: String(recipientId),
          userRole: recipientRole,
          title: "New Campaign Invite",
          body: `${brand?.brandName || "A brand"} invited you to "${campaign.title}"`,
          url: recipientRole === "photographer" ? "/photographer-dashboard" : "/influencer-dashboard",
        })
        .catch(() => {
          /* non-critical */
        });
    } catch (err) {
      console.error("Failed to send invite email:", err);
    }

    return saved;
  }

  async findByCampaign(campaignId: string) {
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

      return enriched;
    } catch {
      return [];
    }
  }

  async findByInfluencer(influencerId: string) {
    const invites: any[] = await this.inviteModel
      .find({
        influencerId,
        $or: [{ recipientRole: { $exists: false } }, { recipientRole: "influencer" }],
      })
      .populate(
        "campaignId",
        "title description status campaignMode budgetMin budgetMax campaignType pricePerInfluencer maxInfluencers startDate endDate timelineStart timelineEnd deliverables platforms socialMedia specialInstructions venueName venueAddress venueCity venueDistrict venueState venueGoogleMapUrl productValue productDescription productPaymentMode productPaymentAmount inviteBenefits payToJoinBenefits payToJoinInstructions",
      )
      .populate(
        "brandId",
        "brandName brandUsername brandLogo location categories website email phoneNumber",
      )
      .lean();

    // Strip brand contact details from invites that haven't been unlocked yet
    return invites.map((inv: any) => {
      if (!inv.unlocked && inv.brandId) {
        const { email: _e, phoneNumber: _p, ...safeB } = inv.brandId;
        return { ...inv, brandId: safeB };
      }
      return inv;
    });
  }

  async findByPhotographer(photographerId: string) {
    const invites: any[] = await this.inviteModel
      .find({
        influencerId: photographerId,
        recipientRole: "photographer",
      })
      .populate(
        "campaignId",
        "title description status campaignMode budgetMin budgetMax campaignType pricePerInfluencer maxInfluencers startDate endDate timelineStart timelineEnd deliverables platforms socialMedia specialInstructions venueName venueAddress venueCity venueDistrict venueState venueGoogleMapUrl productValue productDescription productPaymentMode productPaymentAmount inviteBenefits payToJoinBenefits payToJoinInstructions",
      )
      .populate(
        "brandId",
        "brandName brandUsername brandLogo location categories website email phoneNumber",
      )
      .lean();

    return invites.map((inv: any) => {
      if (!inv.unlocked && inv.brandId) {
        const { email: _e, phoneNumber: _p, ...safeB } = inv.brandId;
        return { ...inv, brandId: safeB };
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
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select("title platforms socialMedia deliverables specialInstructions")
      .lean();
    return { invite, campaign };
  }

  /**
   * Brand-initiated contact unlock. Single rule: brand pays/premium → both sides see contact.
   * Eligible paths:
   *  - Brand has active premium → unlocked instantly.
   *  - Campaign is `paid_collab` AND invite status is `payment_confirmed` (or beyond) → unlocked.
   *  - Brand has not used their 1 free unlock yet → unlocked + freeUnlocksUsed += 1.
   *  - Otherwise → 402-style BadRequest with upgrade message.
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

    // Must have at least accepted before unlocking
    const unlockableStatuses = new Set([
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
    ]);
    if (!unlockableStatuses.has(invite.status)) {
      throw new BadRequestException(
        "Invite must be accepted by the influencer before contact can be unlocked.",
      );
    }

    // Fetch campaign to check type (used for gate + unlock label)
    const campaign: any = await this.campaignModel
      .findById(invite.campaignId)
      .select("campaignType")
      .lean();
    const isPaidCollab =
      campaign && String(campaign.campaignType) === "paid_collab";

    // For paid_collab campaigns, contact unlock requires payment confirmation
    if (isPaidCollab && invite.status === "accepted") {
      throw new BadRequestException(
        "Payment must be confirmed before unlocking contact for paid collaboration campaigns.",
      );
    }

    // Determine unlock type for record-keeping
    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const hasPremium = !!caps.hasPremium;

    let unlockType: "premium" | "paid_collab_payment" | "free_unlock" =
      "free_unlock";

    if (hasPremium) {
      unlockType = "premium";
    } else if (isPaidCollab) {
      unlockType = "paid_collab_payment";
    }

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

  /** Internal: load an invite and assert that the caller (brandId) owns it. */
  private async assertBrandOwnsInvite(inviteId: string, brandId: string) {
    const invite: any = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
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
        .select("name")
        .lean();
      if (influencer?.email) {
        const campaignTitle = campaign?.title || "a campaign";
        const brandName = brand?.name || "A brand";
        const dueLine = invite.dueDate
          ? `\nDeliverable due: ${new Date(invite.dueDate).toDateString()}.`
          : "";
        const dueLineHtml = invite.dueDate
          ? `<p style="margin:8px 0;color:#475467;"><strong>Deliverable due:</strong> ${new Date(invite.dueDate).toDateString()}</p>`
          : "";
        const inviteUrl =
          (process.env.FRONTEND_URL || "https://trendstarz.com") +
          "/influencer-dashboard/invites";
        const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
        <tr><td style="background:#0d6efd;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:600;">TrendStarz</td></tr>
        <tr><td style="padding:24px;">
          <h2 style="margin:0 0 12px 0;font-size:20px;color:#111827;">Friendly reminder</h2>
          <p style="margin:0 0 12px 0;line-height:1.5;">Hi ${influencer.name || "there"},</p>
          <p style="margin:0 0 12px 0;line-height:1.5;">
            <strong>${brandName}</strong> is waiting on your response for the campaign
            <strong>"${campaignTitle}"</strong>.
          </p>
          ${dueLineHtml}
          <p style="margin:20px 0;">
            <a href="${inviteUrl}" style="display:inline-block;background:#0d6efd;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Open my invites</a>
          </p>
          <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">
            If you've already responded, you can safely ignore this message.
          </p>
        </td></tr>
        <tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px;text-align:center;">
          — TrendStarz
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
        await sendAppEmail({
          to: influencer.email,
          subject: `Reminder: ${brandName} is waiting on \"${campaignTitle}\"`,
          text: `Hi ${influencer.name || ""},\n\n${brandName} sent you a reminder about the invite for \"${campaignTitle}\".${dueLine}\n\nPlease open TrendStarz and respond at your earliest convenience.\n\n— TrendStarz`,
          html,
        });
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

  /** Brand withdraws a pending/accepted invite before execution starts. */
  async withdrawInvite(inviteId: string, brandId: string, reason?: string) {
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    if (invite.status !== "pending" && invite.status !== "accepted") {
      throw new BadRequestException(
        "Only pending or accepted invites can be withdrawn. Use Report for progressed invites.",
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
  async reportInviteIssue(
    inviteId: string,
    brandId: string,
    reason: string,
  ) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException("A reason is required when reporting.");
    }
    const invite = await this.assertBrandOwnsInvite(inviteId, brandId);
    invite.reportedIssue = {
      reason: reason.trim(),
      reportedAt: new Date(),
    };
    // Move into disputed unless already completed
    if (
      invite.status !== "completed" &&
      invite.status !== "disputed" &&
      invite.status !== "withdrawn"
    ) {
      invite.status = "disputed";
    }
    invite.updatedAt = new Date();
    await invite.save();

    this.pushService
      .sendToUser(String(invite.influencerId), {
        title: "Campaign Marked Disputed",
        body: "A brand reported an issue on your campaign collaboration.",
        url: "/influencer-dashboard",
      })
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(invite.influencerId),
        userRole: "influencer",
        title: "Campaign Marked Disputed",
        body: "A brand reported an issue on your campaign collaboration.",
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
    status: "accepted" | "declined",
    selectedPostDate?: string,
    selectedPlatform?: string,
    selectedContentType?: string,
    payout?: {
      upiId?: string;
      mobile?: string;
      accountHolderName?: string;
    },
  ) {
    const normalized = (v: string) => (v || "").toLowerCase().trim();
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "pending") {
      throw new BadRequestException("Invite already responded to");
    }

    const recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
    const recipient = await this.loadRecipientProfile(recipientRole, influencerId);
    if (!recipient) {
      throw new NotFoundException(
        recipientRole === "photographer" ? "Photographer not found" : "Influencer not found",
      );
    }

    if (status === "accepted") {
      if (!selectedPostDate) {
        throw new BadRequestException("selectedPostDate is required to accept");
      }
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select(
          "startDate endDate timelineStart timelineEnd socialMedia platforms campaignMode minInfluencerTier minInfluencers maxInfluencers acceptanceDeadline",
        )
        .lean();
      if (!campaign) throw new NotFoundException("Campaign not found");

      const influencer = recipientRole === "photographer"
        ? await this.photographerModel.findById(influencerId).select("socialMedia").lean()
        : await this.influencerModel.findById(influencerId).select("socialMedia").lean();
      if (!influencer) {
        throw new NotFoundException(
          recipientRole === "photographer" ? "Photographer not found" : "Influencer not found",
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

      const acceptanceCloseAt = Number(campaign?.maxInfluencers || 0);
      if (acceptanceCloseAt > 0) {
        // 'disputed' (no-show) is excluded so the slot re-opens for a replacement
        const acceptedCount = await this.inviteModel.countDocuments({
          campaignId: invite.campaignId,
          status: {
            $in: [
              "accepted",
              "payment_confirmed",
              "working",
              "submitted",
              "completed",
              "approved",
            ],
          },
        });
        if (acceptedCount >= acceptanceCloseAt) {
          throw new BadRequestException(
            `Campaign is closed: required recipient count reached (${acceptanceCloseAt}).`,
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
      invite.insightsUnlocksAt = new Date(selected.getTime() + 24 * 60 * 60 * 1000);
      invite.acceptedAt = new Date();

      const isTierFilteredOpen = String(campaign?.campaignMode || "") === "tier_filtered_open";
      const recipientCanUsePlatformRules = recipientRole !== "photographer";
      const lockedPlatform = recipientCanUsePlatformRules && !isTierFilteredOpen
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
        ? (selectedPlatform || lockedPlatform || undefined)
        : undefined;

      if (recipientCanUsePlatformRules && isTierFilteredOpen && effectivePlatform) {
        const TIER_ORDER = [
          "Starter", "Nano", "Micro", "Mid-Tier", "Macro", "Mega / Celebrity",
        ];
        const campaignPlatforms: string[] = Array.isArray(campaign?.platforms)
          ? campaign.platforms
          : [];
        const influencerSocials: any[] = Array.isArray((influencer as any)?.socialMedia)
          ? (influencer as any).socialMedia
          : [];

        if (
          campaignPlatforms.length > 0 &&
          !campaignPlatforms.some((platform) => normalized(platform) === normalized(effectivePlatform))
        ) {
          throw new BadRequestException(
            `Invalid platform. This campaign accepts: ${campaignPlatforms.join(", ")}.`,
          );
        }

        const matchingProfile = influencerSocials.find(
          (entry: any) => normalized(entry?.platform || "") === normalized(effectivePlatform),
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

      // Store chosen platform/content type and resolve agreed amount
      if (effectivePlatform) invite.selectedPlatform = effectivePlatform;
      if (selectedContentType) invite.selectedContentType = selectedContentType;
      if (
        recipientCanUsePlatformRules &&
        effectivePlatform &&
        selectedContentType &&
        campaign.socialMedia?.length
      ) {
        const smEntry = campaign.socialMedia.find(
          (sm: any) =>
            (sm.platform || "").toLowerCase() ===
            effectivePlatform.toLowerCase(),
        );
        const ctEntry = smEntry?.contentTypes?.find(
          (ct: any) =>
            (ct.name || "").toLowerCase() ===
              selectedContentType.toLowerCase() && ct.enabled,
        );
        if (ctEntry?.price) invite.agreedAmount = Number(ctEntry.price);
      }

      // Persist confirmed payout details on the influencer profile so admin
      // can prefill the payout popup later. Only update fields the influencer
      // actually provided/edited.
      if (recipientRole !== "photographer" && payout && (payout.upiId || payout.mobile || payout.accountHolderName)) {
        const set: any = { "payout.lastConfirmedAt": new Date() };
        const upiId = String(payout.upiId || "").trim();
        const mobile = String(payout.mobile || "").trim();
        const accountHolderName = String(payout.accountHolderName || "").trim();
        if (upiId) set["payout.upiId"] = upiId;
        if (mobile) set["payout.mobile"] = mobile;
        if (accountHolderName) set["payout.accountHolderName"] = accountHolderName;
        try {
          if (Object.keys(set).length > 1) {
            await this.influencerModel.findByIdAndUpdate(influencerId, { $set: set });
          }
        } catch (err) {
          console.error("Failed to persist recipient payout details:", err);
        }
      }
    }

    invite.status = status;
    const updated = await invite.save();

    // Log acceptance details for observability (platform/content/tier)
    if (status === 'accepted') {
      try {
        const recipientRole = this.normalizeRecipientRole(invite?.recipientRole);
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
        console.error('Logging failure for invite accept:', e);
      }
    }

    // Send notification email to brand on acceptance
    if (status === "accepted") {
      try {
        const brand: any = await this.brandModel
          .findById(invite.brandId)
          .select("email brandName")
          .lean();
        const recipient: any = await this.loadRecipientProfile(
          recipientRole,
          influencerId,
        );
        const campaign: any = await this.campaignModel
          .findById(invite.campaignId)
          .select("title")
          .lean();
        if (brand?.email) {
          const text = `Hi ${brand.brandName || ""},\n\n${recipient?.name || `A ${recipientRole}`} has accepted your campaign invite for "${campaign?.title || ""}".\n`;
          await sendAppEmail({
            to: brand.email,
            subject: "Campaign Invite Accepted",
            text,
          });
        }
        // Push notification to brand
        this.pushService.sendToUser(String(invite.brandId), {
          title: "Invite Accepted ✅",
          body: `${recipient?.name || `A ${recipientRole}`} accepted your invite for "${campaign?.title || "your campaign"}"`,
          url: "/campaign-management",
        }).catch(() => { /* non-critical */ });
        this.notificationsService
          .createForUser({
            userId: String(invite.brandId),
            userRole: "brand",
            title: "Invite Accepted",
            body: `${recipient?.name || `A ${recipientRole}`} accepted your invite for "${campaign?.title || "your campaign"}"`,
            url: "/campaign-management",
          })
          .catch(() => {
            /* non-critical */
          });
      } catch (e) {
        console.error("Failed to send acceptance email:", e);
      }
    }

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

  async applyToCampaign(influencerId: string, campaignId: string, selectedPlatform?: string) {
    const TIER_ORDER = [
      "Starter", "Nano", "Micro", "Mid-Tier", "Macro", "Mega / Celebrity",
    ];

    const campaign = await this.campaignModel.findById(campaignId).lean() as any;
    if (!campaign) throw new NotFoundException("Campaign not found");

    if (campaign.campaignMode !== "tier_filtered_open") {
      throw new BadRequestException(
        "This campaign is invite-only. You can respond only when a brand sends you an invite.",
      );
    }

    if (campaign.status !== "active") {
      throw new BadRequestException("This campaign is not currently accepting applications.");
    }

    // Check influencer meets minimum tier requirement
    const influencer = await this.influencerModel.findById(influencerId).lean();
    if (!influencer) throw new NotFoundException("Influencer not found");

    const sm: any[] = (influencer as any).socialMedia || [];
    const campaignPlatforms: string[] = campaign.platforms || [];
    const normalized = (s: string) => (s || "").toLowerCase().trim();

    // Validate selectedPlatform — if provided, it must be campaign-targeted and present on influencer profile.
    // If not provided, do not auto-select; influencer will choose platform/content in pending step.
    let chosenPlatform: string | null = null;
    if (campaignPlatforms.length > 0) {
      if (selectedPlatform) {
        const isValid = campaignPlatforms.some((p) => normalized(p) === normalized(selectedPlatform));
        if (!isValid) {
          throw new BadRequestException(
            `Invalid platform. This campaign accepts: ${campaignPlatforms.join(", ")}.`,
          );
        }
        const hasPlatform = sm.some((entry) => normalized(entry.platform) === normalized(selectedPlatform));
        if (!hasPlatform) {
          throw new BadRequestException(
            `You don't have ${selectedPlatform} in your profile. Please add it first.`,
          );
        }
        chosenPlatform = selectedPlatform;
      } else {
        const hasAnyCampaignPlatform = sm.some((entry) =>
          campaignPlatforms.some((p) => normalized(p) === normalized(entry.platform)),
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
        ? sm.filter((entry: any) => normalized(entry.platform) === normalized(chosenPlatform))
        : campaignPlatforms.length > 0
          ? sm.filter((entry: any) => campaignPlatforms.some((p) => normalized(p) === normalized(entry.platform)))
          : sm;
      const hasExactTier =
        minIdx !== -1 &&
        scope.some((entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === minIdx);
      if (minIdx !== -1 && !hasExactTier) {
        const platformLabel = chosenPlatform ? ` on ${chosenPlatform}` : "";
        throw new BadRequestException(
          `This campaign requires exactly ${campaign.minInfluencerTier} tier influencers${platformLabel}.`,
        );
      }
    }

    // Check state/district targeting eligibility
    if (campaign.targetState) {
      const infState = (influencer as any).location?.state ?? "";
      if (infState && infState !== campaign.targetState) {
        throw new BadRequestException(
          `This campaign is limited to influencers from ${campaign.targetState}.`,
        );
      }
    }
    if (campaign.targetDistrict) {
      const infDistrict = (influencer as any).location?.district ?? "";
      if (infDistrict && infDistrict !== campaign.targetDistrict) {
        throw new BadRequestException(
          `This campaign is limited to influencers from ${campaign.targetDistrict}, ${campaign.targetState}.`,
        );
      }
    }

    // Check max slots not exceeded
    const acceptedCount = await this.inviteModel.countDocuments({
      campaignId,
      status: { $in: ["accepted", "completed"] },
    });
    if (campaign.maxInfluencers && acceptedCount >= campaign.maxInfluencers) {
      throw new BadRequestException("This campaign has reached its maximum number of influencers.");
    }

    // Prevent duplicate application
    const existing = await this.inviteModel.findOne({ campaignId, influencerId }).lean();
    if (existing) {
      throw new BadRequestException("You have already applied to this campaign.");
    }

    // Create pending invite (brand still reviews)
    const invite = await this.inviteModel.create({
      campaignId,
      influencerId,
      brandId: campaign.brandId,
      status: "pending",
      selectedPlatform: chosenPlatform ?? null,
      agreedAmount: campaign.pricePerInfluencer ?? 0,
    });

    // Notify brand
    await this.pushService.sendToUser(String(campaign.brandId), {
      title: "New Campaign Application 📩",
      body: `${(influencer as any).fullName || "An influencer"} applied to your campaign "${campaign.title}".`,
      url: "/brand/campaigns",
    });
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

    return { message: "Application submitted. Awaiting brand approval.", inviteId: invite._id };
  }

  /* ── Submission Flow ──────────────────────────────────────────────────── */

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
    if (
      !["accepted", "payment_confirmed", "working", "submitted"].includes(
        invite.status,
      )
    ) {
      throw new BadRequestException(
        `Can only submit for active invites. Status was: ${invite.status}`,
      );
    }
    if (!data.postUrl) throw new BadRequestException("Post URL is required");
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
      const p = String(v || "").toLowerCase().trim();
      if (p === "x") return "twitter";
      return p;
    };
    const normalizeContentType = (v: string) => {
      const t = String(v || "").toLowerCase().trim();
      if (t === "reels") return "reel";
      if (t === "shorts") return "short";
      if (t === "stories") return "story";
      if (t === "post" || t === "image") return "photo";
      return t;
    };

    const acceptedPlatform = normalizePlatform(String(invite.selectedPlatform || ""));
    if (acceptedPlatform && normalizePlatform(postPlatform) !== acceptedPlatform) {
      throw new BadRequestException(
        `This invite is accepted for ${invite.selectedPlatform}. Please submit only ${invite.selectedPlatform} post URL.`,
      );
    }

    const acceptedContentType = normalizeContentType(String(invite.selectedContentType || ""));
    const submittedContentType = normalizeContentType(String(data.postType || ""));
    if (acceptedContentType && submittedContentType && acceptedContentType !== submittedContentType) {
      throw new BadRequestException(
        `This invite requires ${invite.selectedContentType}. Please submit the agreed content type.`,
      );
    }

    const engagementRate = computeEngagementRate(data);

    // Upsert: one submission per invite
    const existing = await this.submissionModel.findOne({ inviteId });
    let submission;
    if (existing) {
      Object.assign(existing, {
        ...data,
        postPlatform,
        engagementRate,
        submittedAt: new Date(),
        status: "submitted",
      });
      submission = await existing.save();
    } else {
      submission = await this.submissionModel.create({
        campaignId: invite.campaignId,
        influencerId,
        inviteId,
        ...data,
        postPlatform,
        engagementRate,
        submittedAt: new Date(),
        status: "submitted",
      });
    }

    // Update invite status to submitted
    invite.status = "submitted";
    await invite.save();

    await this.campaignTransactionModel.updateMany(
      { inviteId },
      { $set: { workStatus: "submitted" } },
    );

    // Notify brand
    try {
      const brand: any = await this.brandModel
        .findById(invite.brandId)
        .select("email brandName")
        .lean();
      const influencer: any = await this.influencerModel
        .findById(influencerId)
        .select("name")
        .lean();
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("title")
        .lean();
      if (brand?.email) {
        await sendAppEmail({
          to: brand.email,
          subject: "Post Submitted for Review",
          text: `Hi ${brand.brandName || ""},\n\n${influencer?.name || "An influencer"} has submitted their post for campaign "${campaign?.title || ""}". Please review it in your dashboard.\n`,
        });
      }
    } catch (e) {
      console.error("Failed to send submission email:", e);
    }

    this.notificationsService
      .createForUser({
        userId: String(invite.brandId),
        userRole: "brand",
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
    const submissions = await this.submissionModel
      .find({ campaignId })
      .populate("influencerId", "name username profileImages socialMedia")
      .lean();
    return { success: true, submissions };
  }

  async reviewSubmission(
    inviteId: string,
    brandId: string,
    action: "approve" | "dispute",
    feedback?: string,
    disputeReason?: string,
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
    if (action === "approve") {
      submission.status = "approved";
      submission.brandFeedback = feedback || "";
      submission.reviewedAt = now;
      await submission.save();

      invite.status = "completed";
      await invite.save();

      const txs = await this.campaignTransactionModel.find({ inviteId });
      for (const tx of txs) {
        tx.workStatus = "approved";
        tx.payoutStatus =
          tx.collectionStatus === "verified" ? "processing" : "pending";
        await tx.save();
      }

      // Notify influencer
      try {
        const influencer: any = await this.influencerModel
          .findById(invite.influencerId)
          .select("email name")
          .lean();
        if (influencer?.email) {
          await sendAppEmail({
            to: influencer.email,
            subject: "Brand approved your post!",
            text: `Hi ${influencer.name || ""},\n\nThe brand has approved your post for campaign "${campaign.title || ""}". Your payout is being processed.\n`,
          });
        }
        // Push notification — payout now processing
        this.pushService.sendToUser(String(invite.influencerId), {
          title: "Post Approved! 🎉",
          body: `Your post for "${campaign.title || "the campaign"}" was approved. Payout is being processed.`,
          url: "/influencer-dashboard",
        }).catch(() => { /* non-critical */ });
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
        console.error("Failed to send approval email:", e);
      }
    } else {
      submission.status = "disputed";
      submission.disputeReason = disputeReason || "";
      submission.brandFeedback = feedback || "";
      submission.reviewedAt = now;
      await submission.save();

      invite.status = "disputed";
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
            disputeReason: disputeReason || feedback || "Brand raised a content dispute",
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
        })
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
    const filter: any = {};
    if (opts.status === "resolved") {
      filter["reportedIssue.resolvedAt"] = { $ne: null };
    } else if (opts.status === "all") {
      filter["reportedIssue.reportedAt"] = { $ne: null };
    } else {
      // default: open
      filter.status = "disputed";
      filter["reportedIssue.resolvedAt"] = { $in: [null, undefined] };
    }

    const invites = await this.inviteModel
      .find(filter)
      .sort({ "reportedIssue.reportedAt": -1, updatedAt: -1 })
      .limit(limit)
      .lean();

    if (!invites.length) return { invites: [] };

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
        .select("title campaignType ownerType")
        .lean(),
      this.brandModel
        .find({ _id: { $in: brandIds } })
        .select("name email")
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
    const bMap = new Map(brands.map((b: any) => [String(b._id), b]));
    const pMap = new Map(photographers.map((p: any) => [String(p._id), p]));
    const iMap = new Map(influencers.map((i: any) => [String(i._id), i]));

    return {
      invites: invites.map((inv: any) => ({
        ...inv,
        campaign: cMap.get(String(inv.campaignId)) || null,
        brand: bMap.get(String(inv.brandId)) || pMap.get(String(inv.brandId)) || null,
        influencer: iMap.get(String(inv.influencerId)) || null,
      })),
    };
  }

  /** Admin: mark a dispute resolved with optional note + outcome status. */
  async adminResolveDispute(
    inviteId: string,
    body: {
      outcome?: "completed" | "withdrawn" | "disputed";
      note?: string;
    } = {},
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (!invite.reportedIssue?.reportedAt) {
      throw new BadRequestException("Invite has no reported issue.");
    }
    invite.reportedIssue.resolvedAt = new Date();
    if (body.note) {
      invite.reportedIssue.reason =
        (invite.reportedIssue.reason || "") +
        `\n[admin ${new Date().toISOString()}]: ${body.note}`;
    }
    if (
      body.outcome &&
      ["completed", "withdrawn", "disputed"].includes(body.outcome)
    ) {
      invite.status = body.outcome;
      if (body.outcome === "withdrawn" && !invite.withdrawnAt) {
        invite.withdrawnAt = new Date();
      }
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

  /** Admin: lightweight count of open disputes (for nav badges). */
  async adminCountOpenDisputes(): Promise<{ count: number }> {
    const cacheKey = "admin:disputes:count";
    const cached = this.getCachedAttention<{ count: number }>(cacheKey);
    if (cached) return cached;
    const count = await this.inviteModel.countDocuments({
      status: "disputed",
      "reportedIssue.resolvedAt": { $in: [null, undefined] },
    });
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
        status: "disputed",
        "reportedIssue.resolvedAt": { $in: [null, undefined] },
      }),
      this.inviteModel.countDocuments({
        ...brandFilter,
        dueDate: { $lt: now, $ne: null },
        status: { $nin: ["completed", "withdrawn", "disputed", "rejected"] },
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
        }),
        this.inviteModel.countDocuments({
          ...idFilter,
          status: "disputed",
          "reportedIssue.resolvedAt": { $in: [null, undefined] },
        }),
      ]);
    const result = { pendingInvites, overdueDeliverables, disputedAgainstMe };
    this.setCachedAttention(cacheKey, result);
    return result;
  }
}
