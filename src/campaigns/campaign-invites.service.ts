import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import { PlansService } from "../plans/plans.service";

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
  constructor(
    @InjectModel("CampaignInvite")
    private readonly inviteModel: Model<any>,
    @InjectModel("CampaignSubmission")
    private readonly submissionModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly campaignTransactionModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

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
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthInviteCount = await this.inviteModel.countDocuments({
        brandId,
        createdAt: { $gte: monthStart },
      });
      if (monthInviteCount >= maxInvitesPerMonthEntry.value) {
        throw new BadRequestException(
          `Plan limit: Only ${maxInvitesPerMonthEntry.value} campaign(s) with invites per month allowed. Upgrade for more.`,
        );
      }
    }
    const invite = new this.inviteModel({ ...data, brandId });
    const saved = await invite.save();

    // Send notification email to influencer
    try {
      const influencer: any = await this.influencerModel
        .findById(data.influencerId)
        .select("email name")
        .lean();
      const brand: any = await this.brandModel
        .findById(brandId)
        .select("brandName")
        .lean();
      if (influencer?.email) {
        const text = `Hi ${influencer.name || ""},\n\nYou have a new campaign invite from ${brand?.brandName || "a brand"} for "${campaign.title}".\nLog in to TrendStarz to respond.\n`;
        await sendAppEmail({
          to: influencer.email,
          subject: "New Campaign Invite",
          text,
        });
      }
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
      const invites = await this.inviteModel
        .find({ $or: queries })
        .populate(
          "influencerId",
          "name email username profileImages socialMedia location",
        )
        .lean();
      return Array.isArray(invites) ? invites : [];
    } catch {
      return [];
    }
  }

  async findByInfluencer(influencerId: string) {
    return this.inviteModel
      .find({ influencerId })
      .populate(
        "campaignId",
        "title description status budgetMin budgetMax campaignType pricePerInfluencer maxInfluencers startDate endDate timelineStart timelineEnd deliverables platforms",
      )
      .populate("brandId", "brandName brandLogo")
      .lean();
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

  async respond(
    inviteId: string,
    influencerId: string,
    status: "accepted" | "declined",
    selectedPostDate?: string,
    selectedPlatform?: string,
    selectedContentType?: string,
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "pending") {
      throw new BadRequestException("Invite already responded to");
    }

    if (status === "accepted") {
      if (!selectedPostDate) {
        throw new BadRequestException("selectedPostDate is required to accept");
      }
      const campaign: any = await this.campaignModel
        .findById(invite.campaignId)
        .select("startDate endDate timelineStart timelineEnd socialMedia")
        .lean();
      if (!campaign) throw new NotFoundException("Campaign not found");

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
      invite.acceptedAt = new Date();

      // Store chosen platform/content type and resolve agreed amount
      if (selectedPlatform) invite.selectedPlatform = selectedPlatform;
      if (selectedContentType) invite.selectedContentType = selectedContentType;
      if (
        selectedPlatform &&
        selectedContentType &&
        campaign.socialMedia?.length
      ) {
        const smEntry = campaign.socialMedia.find(
          (sm: any) =>
            (sm.platform || "").toLowerCase() ===
            selectedPlatform.toLowerCase(),
        );
        const ctEntry = smEntry?.contentTypes?.find(
          (ct: any) =>
            (ct.name || "").toLowerCase() ===
              selectedContentType.toLowerCase() && ct.enabled,
        );
        if (ctEntry?.price) invite.agreedAmount = Number(ctEntry.price);
      }
    }

    invite.status = status;
    const updated = await invite.save();

    // Send notification email to brand on acceptance
    if (status === "accepted") {
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
          const text = `Hi ${brand.brandName || ""},\n\n${influencer?.name || "An influencer"} has accepted your campaign invite for "${campaign?.title || ""}".\n`;
          await sendAppEmail({
            to: brand.email,
            subject: "Campaign Invite Accepted",
            text,
          });
        }
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

  async applyToCampaign(influencerId: string, campaignId: string) {
    const caps = await this.plansService.getUserPlanCapabilities(influencerId);
    const maxApplications =
      caps.limits.find((l: any) => l.key === "maxCampaignApplications")
        ?.value ?? 2;
    // Count applications this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const appCount = await this.inviteModel.countDocuments({
      influencerId,
      createdAt: { $gte: monthStart },
      status: { $in: ["pending", "accepted"] },
    });
    if (appCount >= maxApplications) {
      throw new BadRequestException(
        `Plan limit: Only ${maxApplications} campaign applications per month allowed. Upgrade for more.`,
      );
    }
    // Create application (invite with status 'pending')
    const invite = new this.inviteModel({
      influencerId,
      campaignId,
      status: "pending",
    });
    return await invite.save();
  }

  /* ── Submission Flow ──────────────────────────────────────────────────── */

  async submitPost(
    inviteId: string,
    influencerId: string,
    data: {
      postUrl: string;
      postType?: string;
      captionUsed?: string;
      postScreenshotUrl: string;
      insightsScreenshotUrl?: string;
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      reachCount?: number;
    },
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    console.log("[submitPost] invite:", invite);
    console.log("[submitPost] influencerId:", influencerId);
    console.log("[submitPost] data:", data);
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
    if (!data.postScreenshotUrl)
      throw new BadRequestException("Post screenshot is required"); // Commented for local testing: allow submission without screenshot

    const postPlatform = detectPlatform(data.postUrl);
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

      await this.campaignTransactionModel.updateMany(
        { inviteId },
        { $set: { workStatus: "disputed", payoutStatus: "skipped" } },
      );
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
}
