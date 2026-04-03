import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["active"],
  active: ["completed"],
  completed: [],
};

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

  async create(brandId: string, data: any) {
    // Enforce campaign creation limit for brands (admin-manageable)
    const brand = await this.brandModel.findById(brandId).lean();
    if (!brand) throw new NotFoundException("Brand not found");
    // Lazy load PlansService to avoid circular dep
    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const maxCampaigns = caps.limits.find((l: any) => l.key === "maxCampaigns")?.value ?? 1;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const count = await this.campaignModel.countDocuments({
      brandId,
      createdAt: { $gte: monthStart },
    });
    if (count >= maxCampaigns) {
      throw new BadRequestException(`Plan limit: Only ${maxCampaigns} campaign(s) per month allowed. Upgrade for more.`);
    }
    const campaign = new this.campaignModel({ ...data, brandId });
    return await campaign.save();
  }

  async findByBrandId(brandId: string) {
    return this.campaignModel.find({ brandId }).sort({ createdAt: -1 }).lean();
  }

  async findByBrandName(brandName: string) {
    const brand: any = await this.brandModel
      .findOne({
        brandName: new RegExp(
          `^${brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      })
      .select("_id")
      .lean();
    if (!brand) return [];
    return this.campaignModel
      .find({ brandId: brand._id })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(id: string) {
    return this.campaignModel.findById(id).lean();
  }

  async update(id: string, brandId: string, data: any) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      throw new BadRequestException("Not your campaign");
    }

    // Enforce status transitions
    if (data.status && data.status !== campaign.status) {
      const allowed = VALID_TRANSITIONS[campaign.status] || [];
      if (!allowed.includes(data.status)) {
        throw new BadRequestException(
          `Cannot transition from '${campaign.status}' to '${data.status}'`,
        );
      }
    }

    Object.assign(campaign, data);
    return campaign.save();
  }

  async remove(id: string, brandId: string) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      throw new BadRequestException("Not your campaign");
    }
    return this.campaignModel.findByIdAndDelete(id);
  }
}
