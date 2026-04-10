import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
  ) {}

  async getInfluencerDashboard(userId: string) {
    const user = (await this.influencerModel.findById(userId).lean()) as any;
    if (!user || Array.isArray(user)) {
      throw new NotFoundException("Influencer not found");
    }
    const invites = await this.inviteModel
      .find({ influencerId: userId })
      .populate("brandId campaignId")
      .lean();
    const stats: Record<string, number> = {
      invited: 0,
      accepted: 0,
      submitted: 0,
      completed: 0,
    };
    const newInvites: any[] = [];
    const activeCampaigns: any[] = [];
    const completedCampaigns: any[] = [];
    for (const invite of invites) {
      if (
        typeof invite.status === "string" &&
        Object.prototype.hasOwnProperty.call(stats, invite.status)
      ) {
        stats[invite.status] = (stats[invite.status] || 0) + 1;
      }
      if (invite.status === "invited") {
        newInvites.push({
          ...invite,
          brand: invite.brandId,
          campaign: invite.campaignId,
        });
      }
      if (invite.status === "accepted" || invite.status === "submitted") {
        activeCampaigns.push({
          ...invite.campaignId,
          inviteId: invite._id,
        });
      }
      if (invite.status === "completed") {
        completedCampaigns.push({
          ...invite.campaignId,
          metrics: invite.analytics,
        });
      }
    }
    return {
      user: {
        name: user?.name || "",
        isEmailVerified: user?.isEmailVerified ?? false,
        isPremium: user?.isPremium ?? false,
        premiumDuration: user?.premiumDuration ?? null,
        premiumStart: user?.premiumStart ?? null,
        premiumEnd: user?.premiumEnd ?? null,
        categories: user?.categories ?? [],
        socialMedia: user?.socialMedia ?? [],
        location: user?.location ?? {},
        profileImages: user?.profileImages ?? [],
      },
      invites: { ...stats, newInvites },
      activeCampaigns,
      completedCampaigns,
    };
  }

  async getBrandDashboard(userId: string) {
    const brand = (await this.brandModel.findById(userId).lean()) as any;
    if (!brand || Array.isArray(brand)) {
      throw new NotFoundException("Brand not found");
    }
    // Ensure userId is an ObjectId for querying campaigns
    const brandObjectId = new Types.ObjectId(userId);
    const campaigns = await this.campaignModel.find({ brandId: brandObjectId }).lean();
    let totalInvites = 0;
    let accepted = 0;
    let completed = 0;
    const campaignStats: any[] = [];
    for (const c of campaigns) {
      const invites = await this.inviteModel.find({ campaignId: c._id }).lean();
      const sent = invites.length;
      const acc = invites.filter((i) => i.status === "accepted").length;
      const comp = invites.filter((i) => i.status === "completed").length;
      totalInvites += sent;
      accepted += acc;
      completed += comp;
      campaignStats.push({
        title: c.title,
        invitesSent: sent,
        accepted: acc,
        completed: comp,
      });
    }
    return {
      brand: {
        brandName: brand?.brandName || "",
        isEmailVerified: brand?.isEmailVerified ?? false,
        isPremium: brand?.isPremium ?? false,
        premiumDuration: brand?.premiumDuration ?? null,
        premiumStart: brand?.premiumStart ?? null,
        premiumEnd: brand?.premiumEnd ?? null,
        categories: brand?.categories ?? [],
        socialMedia: brand?.socialMedia ?? [],
        location: brand?.location ?? {},
        brandLogo: brand?.brandLogo ?? [],
      },
      totalCampaigns: campaigns.length,
      totalInvites,
      accepted,
      completed,
      campaigns: campaignStats,
    };
  }
}
