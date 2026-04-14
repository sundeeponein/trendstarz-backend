import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("CampaignSubmission")
    private readonly submissionModel: Model<any>,
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
    const statusDebug: Record<string, number> = {};
    const newInvites: any[] = [];
    const activeCampaigns: any[] = [];
    const completedCampaigns: any[] = [];
    for (const invite of invites) {
      const st = invite.status as string;
      // Debug: count all raw statuses
      statusDebug[st] = (statusDebug[st] || 0) + 1;
      // Map 'pending' → 'invited' for display; 'accepted', 'submitted', 'completed' are direct
      const mappedStatus = st === "pending" ? "invited" : st;
      if (Object.prototype.hasOwnProperty.call(stats, mappedStatus)) {
        stats[mappedStatus] = (stats[mappedStatus] || 0) + 1;
      }
      if (st === "pending") {
        newInvites.push({
          ...invite,
          brand: invite.brandId,
          campaign: invite.campaignId,
        });
      }
      // Active: accepted, payment_confirmed, working, submitted
      if (
        ["accepted", "payment_confirmed", "working", "submitted"].includes(st)
      ) {
        activeCampaigns.push({
          ...invite.campaignId,
          inviteId: invite._id,
          inviteStatus: st,
        });
      }
      if (st === "completed" || st === "disputed") {
        completedCampaigns.push({
          ...invite.campaignId,
          inviteId: invite._id,
          inviteStatus: st,
          metrics: invite.analytics,
        });
      }
    }
    // Debug: log status counts
    console.log("[Dashboard Debug] Invite status counts:", statusDebug);
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
      invites: { ...stats, newInvites, statusDebug },
      activeCampaigns,
      completedCampaigns,
    };
  }

  async getBrandDashboard(userId: string) {
    const brand = (await this.brandModel.findById(userId).lean()) as any;
    if (!brand || Array.isArray(brand)) {
      throw new NotFoundException("Brand not found");
    }
    // Query campaigns by ObjectId OR brandUsername (string) for legacy compatibility
    const brandObjectId = Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId)
      : null;
    const brandUsername = brand.brandUsername || null;
    const orConditions: any[] = [];
    if (brandObjectId) orConditions.push({ brandId: brandObjectId });
    if (brandUsername) orConditions.push({ brandId: brandUsername });
    orConditions.push({ brandId: userId });
    const campaigns = await this.campaignModel
      .find({ $or: orConditions })
      .lean();
    let totalInvites = 0;
    let accepted = 0;
    let completed = 0;
    const campaignStats: any[] = [];
    for (const c of campaigns) {
      // Query invites by both ObjectId and string campaignId for legacy compatibility
      const campaignIdStr = String(c._id);
      const campaignIdObj = Types.ObjectId.isValid(campaignIdStr)
        ? new Types.ObjectId(campaignIdStr)
        : null;
      const inviteQuery: any[] = [{ campaignId: campaignIdStr }];
      if (campaignIdObj) inviteQuery.push({ campaignId: campaignIdObj });
      const invites = await this.inviteModel.find({ $or: inviteQuery }).lean();
      const sent = invites.length;
      const acc = invites.filter((i) => i.status === "accepted").length;
      const comp = invites.filter((i) => i.status === "completed").length;
      const pend = invites.filter((i) => i.status === "pending").length;
      totalInvites += sent;
      accepted += acc;
      completed += comp;
      campaignStats.push({
        _id: c._id,
        title: c.title,
        status: c.status,
        budgetMin: c.budgetMin,
        budgetMax: c.budgetMax,
        timelineStart: c.timelineStart,
        timelineEnd: c.timelineEnd,
        categories: c.categories,
        invitesSent: sent,
        accepted: acc,
        pending: pend,
        completed: comp,
      });
    }
    const avgResponseRate =
      totalInvites > 0
        ? Math.round(((accepted + completed) / totalInvites) * 100)
        : 0;
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
      activeCampaigns: campaigns.filter((c: any) => c.status === "active")
        .length,
      totalInvites,
      accepted,
      completed,
      avgResponseRate,
      campaigns: campaignStats,
    };
  }
}
