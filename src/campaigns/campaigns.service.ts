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

  private normalizeCampaignPayload(data: any) {
    const normalized: any = { ...data };

    const startDate = data.startDate || data.timelineStart;
    const endDate = data.endDate || data.timelineEnd;
    if (startDate) {
      normalized.startDate = new Date(startDate);
      normalized.timelineStart = normalized.startDate;
    }
    if (endDate) {
      normalized.endDate = new Date(endDate);
      normalized.timelineEnd = normalized.endDate;
    }

    if (normalized.startDate && normalized.endDate) {
      if (new Date(normalized.endDate) < new Date(normalized.startDate)) {
        throw new BadRequestException("End date must be on or after start date");
      }
    }

    if (data.campaignType) {
      normalized.campaignType = String(data.campaignType);
    }

    if (data.pricePerInfluencer !== undefined && data.pricePerInfluencer !== null) {
      const p = Number(data.pricePerInfluencer);
      if (!Number.isFinite(p) || p <= 0) {
        throw new BadRequestException("pricePerInfluencer must be greater than 0 (paise)");
      }
      normalized.pricePerInfluencer = Math.round(p);
    }

    if (data.maxInfluencers !== undefined && data.maxInfluencers !== null) {
      const m = Number(data.maxInfluencers);
      if (!Number.isFinite(m) || m <= 0) {
        throw new BadRequestException("maxInfluencers must be greater than 0");
      }
      normalized.maxInfluencers = Math.round(m);
    }

    if (normalized.pricePerInfluencer && normalized.maxInfluencers) {
      normalized.estimatedBudget =
        normalized.pricePerInfluencer * normalized.maxInfluencers;
      // Backward compatibility for existing budget cards (stored in rupees)
      normalized.budgetMin = Math.floor(normalized.estimatedBudget / 100);
      normalized.budgetMax = Math.floor(normalized.estimatedBudget / 100);
    }

    if (Array.isArray(data.platforms)) {
      normalized.platforms = data.platforms;
      if (!data.platformPreference && data.platforms.length) {
        normalized.platformPreference = String(data.platforms[0]).toLowerCase();
      }
    }

    return normalized;
  }

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
    const normalized = this.normalizeCampaignPayload(data);
    const campaign = new this.campaignModel({ ...normalized, brandId });
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

    const normalized = this.normalizeCampaignPayload(data);
    Object.assign(campaign, normalized);
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
