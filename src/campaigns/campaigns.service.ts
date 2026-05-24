import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending", "pending_review", "active", "needs_changes"],
  pending: ["active", "draft", "needs_changes", "rejected"],
  pending_review: ["active", "needs_changes", "rejected", "draft"],
  needs_changes: ["pending_review", "active", "rejected", "draft"],
  rejected: ["pending_review", "draft"],
  active: ["pending", "pending_review", "completed"],
  completed: [],
};

const TIER_FILTERED_OPEN_ROLLOUT_AT = new Date("2026-05-05T00:00:00.000Z"); // Rolled out May 2026

type CampaignOwnerType = "brand" | "photographer";
type InviteRecipientRole = "influencer" | "photographer";
type RequestKind =
  | "brand_campaign"
  | "creative_requirement"
  | "photographer_collaboration";

type InfluencerFeedScope = "campaign" | "collaboration";

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

  private async resolveInitialCampaignStatus(
    status: unknown,
    ownerType: "brand" | "photographer" = "brand",
  ): Promise<string> {
    const requested = String(status || "").trim().toLowerCase();
    const settings = await this.appSettingsModel.findOne({}).lean().exec();
    const settingsDoc = Array.isArray(settings) ? settings[0] : settings;
    const modeField =
      ownerType === "photographer"
        ? "collaborationApprovalMode"
        : "campaignApprovalMode";
    const mode = String(settingsDoc?.[modeField] || "manual").toLowerCase();

    if (requested === "draft") return "draft";

    // In manual mode, any publish intent goes to moderation first.
    if (mode === "manual") {
      return "pending_review";
    }

    // Auto-live mode keeps drafts as drafts and publishes directly.
    if (["active", "pending_review", "pending", "needs_changes"].includes(requested)) {
      return "active";
    }
    return "active";
  }

  private normalizeCampaignPayload(data: any) {
    const normalized: any = { ...data };

    if (data.campaignMode !== undefined && data.campaignMode !== null) {
      const mode = String(data.campaignMode);
      if (!["invite_only", "tier_filtered_open"].includes(mode)) {
        throw new BadRequestException(
          "campaignMode must be invite_only or tier_filtered_open",
        );
      }
      normalized.campaignMode = mode;
    }

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
        throw new BadRequestException(
          "End date must be on or after start date",
        );
      }
    }

    if (data.acceptanceDeadline !== undefined) {
      if (data.acceptanceDeadline === null || data.acceptanceDeadline === "") {
        normalized.acceptanceDeadline = null;
      } else {
        const deadline = new Date(data.acceptanceDeadline);
        if (Number.isNaN(deadline.getTime())) {
          throw new BadRequestException("acceptanceDeadline is invalid");
        }
        normalized.acceptanceDeadline = deadline;
      }
    }

    const acceptanceDeadline = normalized.acceptanceDeadline;
    if (acceptanceDeadline) {
      if (
        normalized.startDate &&
        acceptanceDeadline < new Date(normalized.startDate)
      ) {
        throw new BadRequestException(
          "acceptanceDeadline cannot be before campaign start date",
        );
      }
      if (
        normalized.endDate &&
        acceptanceDeadline > new Date(normalized.endDate)
      ) {
        throw new BadRequestException(
          "acceptanceDeadline cannot be after campaign end date",
        );
      }
    }

    if (data.campaignType) {
      normalized.campaignType = String(data.campaignType);
    }

    if (
      data.pricePerInfluencer !== undefined &&
      data.pricePerInfluencer !== null
    ) {
      const p = Number(data.pricePerInfluencer);
      if (!Number.isFinite(p) || p <= 0) {
        throw new BadRequestException(
          "pricePerInfluencer must be greater than 0 (paise)",
        );
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

    if (data.minInfluencers !== undefined && data.minInfluencers !== null) {
      const min = Number(data.minInfluencers);
      if (!Number.isFinite(min) || min <= 0) {
        throw new BadRequestException("minInfluencers must be greater than 0");
      }
      normalized.minInfluencers = Math.round(min);
    }

    const maxVal = Number(
      normalized.maxInfluencers ?? data.maxInfluencers ?? 0,
    );
    const minVal = Number(
      normalized.minInfluencers ?? data.minInfluencers ?? 0,
    );
    if (minVal > 0 && maxVal > 0 && minVal > maxVal) {
      throw new BadRequestException(
        "minInfluencers cannot be greater than maxInfluencers",
      );
    }

    if (Array.isArray(data.targetTiers)) {
      normalized.targetTiers = data.targetTiers
        .map((t: any) => String(t))
        .filter(Boolean);
    }
    if (data.targetState !== undefined) {
      normalized.targetState = data.targetState ? String(data.targetState) : undefined;
    }
    if (data.targetDistrict !== undefined) {
      normalized.targetDistrict = data.targetDistrict ? String(data.targetDistrict) : undefined;
    }
    if (Array.isArray(data.targetCities)) {
      normalized.targetCities = data.targetCities
        .map((c: any) => String(c))
        .filter(Boolean);
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

  private assertCampaignModeAvailability(data: any) {
    const mode = String(data?.campaignMode || "invite_only");
    if (!["invite_only", "tier_filtered_open"].includes(mode)) {
      throw new BadRequestException("Invalid campaign access mode.");
    }
  }

  private normalizeInviteRecipientRole(
    value: unknown,
    ownerType: CampaignOwnerType,
  ): InviteRecipientRole {
    if (ownerType === "photographer") {
      return "influencer";
    }
    return String(value || "influencer").trim().toLowerCase() === "photographer"
      ? "photographer"
      : "influencer";
  }

  private resolveRequestKind(
    ownerType: CampaignOwnerType,
    inviteRecipientRole: InviteRecipientRole,
  ): RequestKind {
    if (ownerType === "photographer") {
      return "photographer_collaboration";
    }
    if (inviteRecipientRole === "photographer") {
      return "creative_requirement";
    }
    return "brand_campaign";
  }

  async create(brandId: string, data: any) {
    this.assertCampaignModeAvailability(data);
    // Enforce creation limit for owners (brand/photographer)
    let brand = await this.brandModel.findById(brandId).lean();
    let ownerType: "brand" | "photographer" = "brand";
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
    if (!brand) {
      const photographer = await this.photographerModel.findById(brandId).lean();
      if (!photographer) throw new NotFoundException("Owner profile not found");
      ownerType = "photographer";
    }
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
    // Premium-only collaboration types: Product & Invite
    const premiumOnlyTypes = new Set(["product", "invite_location"]);
    if (
      data?.campaignType &&
      premiumOnlyTypes.has(String(data.campaignType)) &&
      !caps.hasPremium
    ) {
      throw new BadRequestException(
        "Product & Invite opportunities require a Premium plan. Upgrade to unlock these collaboration types.",
      );
    }
    const normalized = this.normalizeCampaignPayload(data);
    const inviteRecipientRole = this.normalizeInviteRecipientRole(
      data?.inviteRecipientRole,
      ownerType,
    );
    if (ownerType === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    if (inviteRecipientRole === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    normalized.ownerType = ownerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      ownerType,
      inviteRecipientRole,
    );
    normalized.status = await this.resolveInitialCampaignStatus(
      data?.status,
      ownerType,
    );
    const campaign = new this.campaignModel({ ...normalized, brandId });
    return await campaign.save();
  }

  async findByBrandId(brandId: string) {
    const results = await this.campaignModel
      .find({ brandId })
      .sort({ createdAt: -1 })
      .lean();

    // Enrich with brand logo so the frontend campaign card shows it
    const brand: any = await this.brandModel
      .findById(brandId)
      .select("brandName brandUsername brandLogo")
      .lean();
    const photographer: any = !brand
      ? await this.photographerModel
          .findById(brandId)
          .select("name profileImages")
          .lean()
      : null;
    const brandInfo = brand
      ? {
          _id: brand._id,
          name: brand.brandName,
          username: brand.brandUsername,
          logo: brand.brandLogo?.[0]?.url || null,
        }
      : photographer
        ? {
            _id: photographer._id,
            name: photographer.name,
            username: null,
            logo: photographer.profileImages?.[0]?.url || null,
          }
      : null;

    return results.map((c: any) => ({ ...c, brand: brandInfo }));
  }

  private normalizeInfluencerFeedScope(scope?: string): InfluencerFeedScope | null {
    const normalized = String(scope || "").trim().toLowerCase();
    if (normalized === "campaign") return "campaign";
    if (normalized === "collaboration") return "collaboration";
    return null;
  }

  private isCollaborationCampaign(campaign: any): boolean {
    const ownerType = String(campaign?.ownerType || campaign?.createdByRole || "")
      .trim()
      .toLowerCase();
    const requestKind = String(campaign?.requestKind || "").trim().toLowerCase();
    return (
      ownerType === "photographer" ||
      ownerType === "videographer" ||
      requestKind === "photographer_collaboration" ||
      requestKind === "videographer_collaboration"
    );
  }

  async findPublic(status: string = "active", influencerId?: string, scope?: string) {
    const TIER_ORDER = ["Starter", "Nano", "Micro", "Mid-Tier", "Macro", "Mega / Celebrity"];
    const allowedStatuses = new Set([
      "active",
      "completed",
    ]);
    const query: any = {};
    if (status && allowedStatuses.has(status)) {
      query.status = status;
    } else {
      query.status = "active";
    }
    const campaigns: any[] = await this.campaignModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Load influencer once for eligibility filtering
    let influencer: any = null;
    if (influencerId) {
      influencer = await this.influencerModel
        .findById(influencerId)
        .select("socialMedia location")
        .lean();
    }

    // Helper: whether influencer has at least one exact-tier match on campaign target platform(s).
    const hasExactTierForCampaign = (
      inf: any,
      campaignPlatforms: string[],
      requiredTier: string,
    ): boolean => {
      const sm: any[] = inf?.socialMedia || [];
      const requiredIdx = TIER_ORDER.indexOf(requiredTier || "");
      if (requiredIdx === -1) return true;
      const normalized = (s: string) => (s || "").toLowerCase().trim();
      if (!campaignPlatforms || campaignPlatforms.length === 0) {
        return sm.some((entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === requiredIdx);
      }
      const matching = sm.filter((entry: any) =>
        campaignPlatforms.some((p) => normalized(p) === normalized(entry.platform)),
      );
      if (matching.length === 0) return false;
      return matching.some((entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === requiredIdx);
    };

    const feedScope = influencerId
      ? this.normalizeInfluencerFeedScope(scope)
      : null;

    // Filter: scope + tier/location eligibility for influencer discovery.
    const visible = campaigns.filter((c) => {
      if (feedScope === "campaign" && this.isCollaborationCampaign(c)) {
        return false;
      }
      if (feedScope === "collaboration" && !this.isCollaborationCampaign(c)) {
        return false;
      }

      if (c.campaignMode !== "tier_filtered_open") return true; // invite_only always shown (brand side)
      if (!influencer) return true; // no influencer context — show all (brand/admin)

      // Tier check — compare against the influencer's tier on the campaign's target platform(s)
      if (c.minInfluencerTier) {
        const hasExactTier = hasExactTierForCampaign(
          influencer,
          c.platforms || [],
          c.minInfluencerTier,
        );
        if (!hasExactTier) return false;
      }

      // State check
      if (c.targetState) {
        const infState = influencer.location?.state ?? "";
        if (infState && infState !== c.targetState) return false;
      }

      // District check
      if (c.targetDistrict) {
        const infDistrict = influencer.location?.district ?? "";
        if (infDistrict && infDistrict !== c.targetDistrict) return false;
      }

      return true;
    });

    // Enrich campaigns with brand info (name, logo, username)
    const brandIds = [
      ...new Set(visible.map((c) => c.brandId).filter(Boolean)),
    ];
    const brands: any[] = await this.brandModel
      .find({ _id: { $in: brandIds } })
      .select("brandName brandUsername brandLogo")
      .lean();
    const photographers: any[] = await this.photographerModel
      .find({ _id: { $in: brandIds } })
      .select("name profileImages")
      .lean();
    const brandMap = new Map(brands.map((b) => [String(b._id), b]));
    const photographerMap = new Map(
      photographers.map((p) => [String(p._id), p]),
    );

    return visible.map((c) => {
      const brand = brandMap.get(String(c.brandId));
      const photographer = photographerMap.get(String(c.brandId));
      return {
        ...c,
        brand: brand
          ? {
              _id: brand._id,
              name: brand.brandName,
              username: brand.brandUsername,
              logo: brand.brandLogo?.[0]?.url || null,
            }
          : photographer
            ? {
                _id: photographer._id,
                name: photographer.name,
                username: null,
                logo: photographer.profileImages?.[0]?.url || null,
              }
          : null,
      };
    });
  }

  async findByBrandName(brandName: string) {
    const brand: any = await this.brandModel
      .findOne({
        brandName: new RegExp(
          `^${brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i", // Case-insensitive match
        ),
      })
      .select(["_id", "brandUsername"])
      .lean();
    if (!brand) return [];
    // Fetch campaigns by ObjectId, string version of ObjectId, and brandUsername
    return this.campaignModel
      .find({
        $or: [
          { brandId: brand._id },
          { brandId: String(brand._id) },
          { brandId: brand.brandUsername },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(id: string) {
    return this.campaignModel.findById(id).lean();
  }

  async update(id: string, brandId: string, data: any) {
    this.assertCampaignModeAvailability(data);
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
      if (
        ["active", "pending", "pending_review", "needs_changes", "rejected"].includes(
          String(data.status),
        )
      ) {
        data.status = await this.resolveInitialCampaignStatus(data.status);
      }
      const allowed = VALID_TRANSITIONS[campaign.status] || [];
      if (!allowed.includes(data.status)) {
        throw new BadRequestException(
          `Cannot transition from '${campaign.status}' to '${data.status}'`,
        );
      }
    }

    // Premium-only campaign types: Product & Invite (Free brands can only run Paid)
    if (data?.campaignType && data.campaignType !== campaign.campaignType) {
      const premiumOnlyTypes = new Set(["product", "invite_location"]);
      if (premiumOnlyTypes.has(String(data.campaignType))) {
        const caps = await this.plansService.getUserPlanCapabilities(brandId);
        if (!caps.hasPremium) {
          throw new BadRequestException(
            "Product & Invite campaigns require a Premium plan. Upgrade to unlock these collaboration types.",
          );
        }
      }
    }

    const campaignOwnerType: CampaignOwnerType =
      String(campaign.ownerType || campaign.createdByRole || "brand") ===
      "photographer"
        ? "photographer"
        : "brand";
    const normalized = this.normalizeCampaignPayload(data);
    const inviteRecipientRole = this.normalizeInviteRecipientRole(
      data?.inviteRecipientRole ?? campaign.inviteRecipientRole,
      campaignOwnerType,
    );
    if (campaignOwnerType === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    if (inviteRecipientRole === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    normalized.ownerType = campaignOwnerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      campaignOwnerType,
      inviteRecipientRole,
    );
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
