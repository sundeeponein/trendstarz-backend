import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";

@Injectable()
export class CampaignInvitesService {
  constructor(
    @InjectModel("CampaignInvite")
    private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
  ) {}

  async create(brandId: string, data: any) {
      async applyToCampaign(influencerId: string, campaignId: string) {
        // Enforce influencer campaign application limit (admin-manageable)
        const { getAppPlansService } = require("../plans/plans.service");
        const plansService = await getAppPlansService();
        const caps = await plansService.getUserPlanCapabilities(influencerId);
        const maxApplications = caps.limits.find((l: any) => l.key === "maxCampaignApplications")?.value ?? 2;
        // Count applications this month
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const appCount = await this.inviteModel.countDocuments({
          influencerId,
          createdAt: { $gte: monthStart },
          status: { $in: ["pending", "accepted"] },
        });
        if (appCount >= maxApplications) {
          throw new BadRequestException(`Plan limit: Only ${maxApplications} campaign applications per month allowed. Upgrade for more.`);
        }
        // Create application (invite with status 'pending')
        const invite = new this.inviteModel({ influencerId, campaignId, status: "pending" });
        return await invite.save();
      }
    const campaign: any = await this.campaignModel
      .findById(data.campaignId)
      .lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      throw new BadRequestException("Not your campaign");
    }
    // Enforce invite limits for brands (admin-manageable)
    const { getAppPlansService } = require("../plans/plans.service");
    const plansService = await getAppPlansService();
    const caps = await plansService.getUserPlanCapabilities(brandId);
    const maxInvitesPerCampaign = caps.limits.find((l: any) => l.key === "maxInvitesPerCampaign")?.value ?? 2;
    const maxInvitesPerMonth = caps.limits.find((l: any) => l.key === "maxInvitesPerMonth")?.value ?? 1;
    // Count invites for this campaign
    const inviteCount = await this.inviteModel.countDocuments({ campaignId: data.campaignId });
    if (inviteCount >= maxInvitesPerCampaign) {
      throw new BadRequestException(`Plan limit: Only ${maxInvitesPerCampaign} invites per campaign allowed. Upgrade for more.`);
    }
    // Count invites sent this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthInviteCount = await this.inviteModel.countDocuments({
      brandId,
      createdAt: { $gte: monthStart },
    });
    if (monthInviteCount >= maxInvitesPerMonth) {
      throw new BadRequestException(`Plan limit: Only ${maxInvitesPerMonth} campaign(s) with invites per month allowed. Upgrade for more.`);
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
    } catch (e) {
      console.error("Failed to send invite email:", e);
    }

    return saved;
  }

  async findByCampaign(campaignId: string) {
    return this.inviteModel
      .find({ campaignId })
      .populate("influencerId", "name email username profileImages")
      .lean();
  }

  async findByInfluencer(influencerId: string) {
    return this.inviteModel
      .find({ influencerId })
      .populate("campaignId", "title description status budgetMin budgetMax")
      .populate("brandId", "brandName brandLogo")
      .lean();
  }

  async respond(
    inviteId: string,
    influencerId: string,
    status: "accepted" | "declined",
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== influencerId) {
      throw new BadRequestException("Not your invite");
    }
    if (invite.status !== "pending") {
      throw new BadRequestException("Invite already responded to");
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
}
