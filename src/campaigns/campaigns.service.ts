import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";
import {
  CampaignTypeConfigItem,
  resolveCampaignTypeConfigs,
} from "../campaign-type-configs";
import { getRequiredFields } from "./campaign-required-fields";

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

type CampaignOwnerType = "brand" | "photographer" | "influencer";
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
    ownerType: CampaignOwnerType = "brand",
  ): Promise<string> {
    const requested = String(status || "").trim().toLowerCase();
    const settings = await this.appSettingsModel.findOne({}).lean().exec();
    const settingsDoc = Array.isArray(settings) ? settings[0] : settings;
    const modeField =
      ownerType === "brand"
        ? "campaignApprovalMode"
        : "collaborationApprovalMode";
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

    // Multi-role invite slots (additive). Sanitize each entry; reject bad
    // role values up front so the document never lands in an invalid state.
    if (Array.isArray(data.inviteSlots)) {
      const allowedRoles = new Set(["influencer", "photographer"]);
      normalized.inviteSlots = data.inviteSlots
        .map((slot: any) => {
          const role = String(slot?.role || "").trim().toLowerCase();
          const count = Number(slot?.count);
          if (!allowedRoles.has(role)) return null;
          if (!Number.isFinite(count) || count <= 0) return null;
          const entry: any = {
            role,
            count: Math.round(count),
            notes: slot?.notes ? String(slot.notes).trim() : "",
          };
          if (slot?.comp !== undefined && slot?.comp !== null) {
            const comp = Number(slot.comp);
            if (Number.isFinite(comp) && comp > 0) {
              entry.comp = Math.round(comp);
            }
          }
          return entry;
        })
        .filter(Boolean);
    }

    // Derive logisticsType (additive discriminator) from the merged payload.
    // Honour an explicit incoming value if it's a known enum, otherwise derive.
    const explicit = String(data?.logisticsType || "").trim();
    const allowed = new Set([
      "none",
      "ship_to_creator",
      "in_person_event",
      "on_location_shoot",
      "remote_delivery",
      "pay_to_join_program",
    ]);
    normalized.logisticsType = allowed.has(explicit)
      ? explicit
      : this.deriveLogisticsType(normalized);

    return normalized;
  }

  /**
   * Derive a logistics flow discriminator from campaign fields. Used to keep
   * fulfilment/analytics code decoupled from creator-facing `campaignType`
   * labels (which can multiply over time without changing the underlying flow).
   */
  private deriveLogisticsType(payload: any): string {
    const type = String(payload?.campaignType || "");
    const ownerType = String(payload?.ownerType || "brand");
    const inviteRole = String(payload?.inviteRecipientRole || "influencer");
    const shootLoc = String(payload?.shootLocationType || "");
    const shipping = payload?.productShippingRequired === true;

    if (type === "invite_location") return "in_person_event";
    if (type === "pay_to_join") return "pay_to_join_program";
    if (type === "product") {
      return shipping ? "ship_to_creator" : "none";
    }
    // Photographer-led collabs (or brand→photographer requirement) with a shoot location.
    const photographerInvolved =
      ownerType === "photographer" || inviteRole === "photographer";
    if (photographerInvolved) {
      if (shootLoc === "remote") return "remote_delivery";
      if (shootLoc) return "on_location_shoot";
    }
    if (type === "creative_project" && shootLoc === "remote") {
      return "remote_delivery";
    }
    return "none";
  }

  private assertCampaignModeAvailability(data: any) {
    const mode = String(data?.campaignMode || "invite_only");
    if (!["invite_only", "tier_filtered_open"].includes(mode)) {
      throw new BadRequestException("Invalid campaign access mode.");
    }
  }

  private getCampaignTypeConfigs(settings: any): CampaignTypeConfigItem[] {
    return resolveCampaignTypeConfigs(settings?.campaignTypeConfigs);
  }

  private assertCampaignTypeAllowed(
    ownerType: CampaignOwnerType,
    selectedType: string,
    hasPremium: boolean,
    settings: any,
  ): void {
    const type = String(selectedType || "").trim();
    if (!type) return;

    const config = this.getCampaignTypeConfigs(settings).find(
      (item) => item.ownerType === ownerType && item.key === type,
    );

    if (!config) {
      throw new BadRequestException("Invalid collaboration type selected.");
    }
    if (!config.enabled) {
      throw new BadRequestException(
        "This collaboration type is currently unavailable.",
      );
    }
    if (config.premiumOnly && !hasPremium) {
      throw new BadRequestException(
        "This collaboration type requires a Premium plan. Upgrade to unlock it.",
      );
    }
  }

  /**
   * Validate that all required fields for the given campaign type are present.
   * Uses the shared `getRequiredFields` rule set so frontend and backend stay
   * in lock-step on what is mandatory per campaign type / owner role.
   */
  private assertRequiredFieldsForCampaign(payload: any): void {
    const required = getRequiredFields({
      campaignType: String(payload?.campaignType || ""),
      ownerType: payload?.ownerType,
      inviteRecipientRole: payload?.inviteRecipientRole,
      productPaymentMode: payload?.productPaymentMode,
      shootLocationType: payload?.shootLocationType,
    });
    const missing: string[] = [];
    for (const name of required) {
      const v = payload?.[name];
      if (v === undefined || v === null) {
        missing.push(name);
        continue;
      }
      if (typeof v === "string" && !v.trim()) missing.push(name);
      else if (typeof v === "number" && !(v > 0)) missing.push(name);
    }
    if (missing.length) {
      throw new BadRequestException(
        `Missing required field(s) for this campaign type: ${missing.join(", ")}`,
      );
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

  private isObjectIdLike(value: string): boolean {
    return /^[a-fA-F0-9]{24}$/.test(String(value || "").trim());
  }

  private async safeFindById(
    model: any,
    id: string,
    selectFields = "_id",
  ): Promise<any | null> {
    try {
      const query = model?.findById?.(id);
      if (!query) return null;
      if (typeof query.select === "function") {
        const selected = query.select(selectFields);
        if (selected && typeof selected.lean === "function") {
          return await selected.lean();
        }
        return await selected;
      }
      if (typeof query.lean === "function") {
        return await query.lean();
      }
      return await query;
    } catch {
      return null;
    }
  }

  private async safeFindOne(
    model: any,
    filter: any,
    selectFields = "_id",
  ): Promise<any | null> {
    try {
      const query = model?.findOne?.(filter);
      if (!query) return null;
      if (typeof query.select === "function") {
        const selected = query.select(selectFields);
        if (selected && typeof selected.lean === "function") {
          return await selected.lean();
        }
        return await selected;
      }
      if (typeof query.lean === "function") {
        return await query.lean();
      }
      return await query;
    } catch {
      return null;
    }
  }

  private async findBrandProfile(ownerId: string): Promise<any | null> {
    const id = String(ownerId || "").trim();
    if (!id) return null;
    if (this.isObjectIdLike(id)) {
      const byId = await this.safeFindById(this.brandModel, id, "_id");
      if (byId) return byId;
    }
    return this.safeFindOne(
      this.brandModel,
      {
        $or: [{ brandUsername: id }, { username: id }],
      },
      "_id",
    );
  }

  private async findPhotographerProfile(ownerId: string): Promise<any | null> {
    const id = String(ownerId || "").trim();
    if (!id) return null;
    if (this.isObjectIdLike(id)) {
      const byId = await this.safeFindById(this.photographerModel, id, "_id");
      if (byId) return byId;
    }
    return this.safeFindOne(
      this.photographerModel,
      {
        $or: [{ username: id }, { photographerUsername: id }],
      },
      "_id",
    );
  }

  private async findInfluencerProfile(ownerId: string): Promise<any | null> {
    const id = String(ownerId || "").trim();
    if (!id) return null;
    if (this.isObjectIdLike(id)) {
      const byId = await this.safeFindById(this.influencerModel, id, "_id");
      if (byId) return byId;
    }
    return this.safeFindOne(
      this.influencerModel,
      { username: id },
      "_id",
    );
  }

  private async resolveOwnerTypeByProfile(
    ownerId: string,
    requesterRole?: string,
  ): Promise<CampaignOwnerType> {
    const normalizedRole = String(requesterRole || "").trim().toLowerCase();
    if (normalizedRole === "photographer" || normalizedRole === "videographer") {
      return "photographer";
    }
    if (normalizedRole === "influencer") {
      return "influencer";
    }
    if (normalizedRole === "brand") {
      return "brand";
    }

    const [brand, photographer, influencer] = await Promise.all([
      this.findBrandProfile(ownerId),
      this.findPhotographerProfile(ownerId),
      this.findInfluencerProfile(ownerId),
    ]);
    if (brand) return "brand";
    if (photographer) return "photographer";
    if (influencer) return "influencer";

    throw new NotFoundException("User profile not found");
  }

  async create(ownerId: string, data: any, requesterRole?: string) {
    this.assertCampaignModeAvailability(data);
    // Enforce creation limit for owners (brand/photographer)
    const ownerType: CampaignOwnerType = await this.resolveOwnerTypeByProfile(
      ownerId,
      requesterRole,
    );
    // Lazy load PlansService to avoid circular dep
    const caps = await this.plansService.getUserPlanCapabilities(ownerId);
    const settings = await this.appSettingsModel.findOne({}).lean().exec();
    const maxCampaigns =
      caps.limits.find((l: any) => l.key === "maxActiveCampaigns")?.value ?? 1;
    // Count currently active/pending/draft campaigns — completed or deleted do NOT count toward the cap
    const count = await this.campaignModel.countDocuments({
      brandId: ownerId,
      status: { $in: ["active", "pending", "draft", "paused"] },
    });
    if (maxCampaigns !== -1 && count >= maxCampaigns) {
      throw new BadRequestException(
        `Plan limit: Only ${maxCampaigns} active campaign(s) allowed. Upgrade for more.`,
      );
    }
    const selectedType = String(data?.campaignType || "");
    this.assertCampaignTypeAllowed(
      ownerType === "influencer" ? "brand" : ownerType,
      selectedType,
      caps.hasPremium,
      settings,
    );
    const persistedOwnerType: CampaignOwnerType =
      ownerType === "influencer" ? "brand" : ownerType;
    const normalized = this.normalizeCampaignPayload(data);
    if (!Number.isFinite(Number(normalized.maxInfluencers)) || Number(normalized.maxInfluencers) <= 0) {
      throw new BadRequestException("maxInfluencers is required and must be greater than 0");
    }
    if (!Number.isFinite(Number(normalized.minInfluencers)) || Number(normalized.minInfluencers) <= 0) {
      normalized.minInfluencers = 1;
    }
    const inviteRecipientRole = this.normalizeInviteRecipientRole(
      data?.inviteRecipientRole,
      persistedOwnerType,
    );
    if (ownerType === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    normalized.ownerType = persistedOwnerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      persistedOwnerType,
      inviteRecipientRole,
    );
    normalized.status = await this.resolveInitialCampaignStatus(
      data?.status,
      ownerType,
    );
    // Re-derive logisticsType now that ownerType/inviteRecipientRole are set
    // (additive discriminator — see deriveLogisticsType).
    normalized.logisticsType = this.deriveLogisticsType(normalized);
    this.assertRequiredFieldsForCampaign(normalized);
    const campaign = new this.campaignModel({ ...normalized, brandId: ownerId });
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

  private isCollaborationCampaign(campaign: any, photographerOwnerIds?: Set<string>): boolean {
    const ownerType = String(campaign?.ownerType || campaign?.createdByRole || "")
      .trim()
      .toLowerCase();
    const requestKind = String(campaign?.requestKind || "").trim().toLowerCase();
    if (
      ownerType === "photographer" ||
      ownerType === "videographer" ||
      requestKind === "photographer_collaboration" ||
      requestKind === "videographer_collaboration"
    ) {
      return true;
    }
    if (photographerOwnerIds?.has(String(campaign?.brandId || ""))) {
      return true;
    }
    return false;
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

    const campaignOwnerIds = [
      ...new Set(campaigns.map((c: any) => String(c?.brandId || "")).filter(Boolean)),
    ];
    const photographerOwnerRows: any[] = campaignOwnerIds.length
      ? await this.photographerModel
          .find({ _id: { $in: campaignOwnerIds } })
          .select("_id")
          .lean()
      : [];
    const photographerOwnerIds = new Set(
      (photographerOwnerRows || []).map((p: any) => String(p?._id || "")).filter(Boolean),
    );

    // Filter: scope + tier/location eligibility for influencer discovery.
    const visible = campaigns.filter((c) => {
      if (feedScope === "campaign" && this.isCollaborationCampaign(c, photographerOwnerIds)) {
        return false;
      }
      if (feedScope === "collaboration" && !this.isCollaborationCampaign(c, photographerOwnerIds)) {
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
              role: "brand",
            }
          : photographer
            ? {
                _id: photographer._id,
                name: photographer.name,
                username: null,
                logo: photographer.profileImages?.[0]?.url || null,
                role: "photographer",
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

    if (data?.campaignType && data.campaignType !== campaign.campaignType) {
      const campaignOwnerType: "brand" | "photographer" =
        String(campaign.ownerType || campaign.createdByRole || "brand") ===
        "photographer"
          ? "photographer"
          : "brand";
      const selectedType = String(data.campaignType);
      const caps = await this.plansService.getUserPlanCapabilities(brandId);
      const settings = await this.appSettingsModel.findOne({}).lean().exec();
      this.assertCampaignTypeAllowed(
        campaignOwnerType,
        selectedType,
        caps.hasPremium,
        settings,
      );
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
    normalized.ownerType = campaignOwnerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      campaignOwnerType,
      inviteRecipientRole,
    );
    // Validate the merged (existing + incoming) document so partial updates
    // don't bypass type-specific required-field rules.
    const mergedForValidation = {
      ...(campaign.toObject ? campaign.toObject() : campaign),
      ...normalized,
    };
    const mergedMax = Number((mergedForValidation as any)?.maxInfluencers || 0);
    if (!Number.isFinite(mergedMax) || mergedMax <= 0) {
      throw new BadRequestException("maxInfluencers is required and must be greater than 0");
    }
    const mergedMin = Number((mergedForValidation as any)?.minInfluencers || 0);
    if (!Number.isFinite(mergedMin) || mergedMin <= 0) {
      normalized.minInfluencers = 1;
      (mergedForValidation as any).minInfluencers = 1;
    }
    // Re-derive logisticsType from the merged document to keep the
    // discriminator consistent across partial updates.
    normalized.logisticsType = this.deriveLogisticsType(mergedForValidation);
    this.assertRequiredFieldsForCampaign(mergedForValidation);
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
