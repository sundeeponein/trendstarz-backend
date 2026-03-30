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
    const campaign: any = await this.campaignModel
      .findById(data.campaignId)
      .lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      throw new BadRequestException("Not your campaign");
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
