import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending", "active"],
  pending: ["active", "draft"],
  active: ["pending", "completed"],
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
    let brand = await this.brandModel.findById(brandId).lean();
    // If brand profile is missing, auto-create a minimal profile with valid dummy values
    if (
      !brand &&
      brandId &&
      typeof brandId === "string" &&
      brandId.length === 24 &&
      /^[a-fA-F0-9]{24}$/.test(brandId)
    ) {
      try {
        const minimalBrand = new this.brandModel({
          _id: brandId,
          brandName: "Brand",
          email: `brand_${brandId}@dummy.com`,
          phoneNumber: "0000000000",
          password: "dummy-password",
          status: "pending",
        });
        brand = (await minimalBrand.save()).toObject();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // If creation fails, throw error with details
        throw new NotFoundException(
          "Brand not found and could not be auto-created: " + msg,
        );
      }
    }
    if (!brand) throw new NotFoundException("Brand not found");
    // Lazy load PlansService to avoid circular dep
    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const maxCampaigns =
      caps.limits.find((l: any) => l.key === "maxActiveCampaigns")?.value ?? 1;
    // Count currently active/pending/draft campaigns — completed or deleted do NOT count toward the cap
    const count = await this.campaignModel.countDocuments({
      brandId,
      status: { $in: ["active", "pending", "draft", "paused"] },
    });
    if (maxCampaigns !== -1 && count >= maxCampaigns) {
      throw new BadRequestException(
        `Plan limit: Only ${maxCampaigns} active campaign(s) allowed. Upgrade for more.`,
      );
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
      .select(["_id", "brandUsername"])
      .lean();
    if (!brand) return [];
    // Fetch campaigns by both ObjectId and string brandId (brandUsername)
    return this.campaignModel
      .find({
        $or: [{ brandId: brand._id }, { brandId: brand.brandUsername }],
      })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(id: string) {
    return this.campaignModel.findById(id).lean();
  }

  async update(id: string, brandId: string, data: any) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) throw new NotFoundException("Campaign not found");
    // Allow update if brandId matches ObjectId or brandUsername
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
