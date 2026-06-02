import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
// Removed direct model imports; use @InjectModel for all models
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as fs from "fs";
import * as path from "path";
import {
  CampaignTypeConfigItem,
  getCampaignTypeConfigDefaults,
  resolveCampaignTypeConfigs,
} from "./campaign-type-configs";
import { seedMissingLocationsFromConfig } from "./utils/location-seed.util";

interface VisibilityItem {
  _id: string;
  showInFrontend: boolean;
}

interface BatchVisibilityBody {
  tiers?: VisibilityItem[];
  socialMedia?: VisibilityItem[];
  categories?: VisibilityItem[];
  languages?: VisibilityItem[];
  states?: VisibilityItem[];
  districts?: VisibilityItem[];
  equipmentOptions?: Array<{ name?: string; visible?: boolean }>;
  pricingOptions?: Array<{ key?: string; label?: string; visible?: boolean }>;
  userTags?: {
    influencer?: Array<{ name: string; visible: boolean }>;
    brand?: Array<{ name: string; visible: boolean }>;
    photographer?: Array<{ name: string; visible: boolean }>;
    commission?: Array<{ name: string; visible: boolean }>;
  };
}

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminListsController {
  private plansConfig: any = null;

  private getAdminConfigPath(): string {
    let configPath = path.join(__dirname, "../assets/admin-config.json");
    if (!fs.existsSync(configPath)) {
      configPath = path.join(process.cwd(), "assets/admin-config.json");
    }
    return configPath;
  }

  private readAdminConfig(): any {
    const configPath = this.getAdminConfigPath();
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw || "{}");
  }

  private writeAdminConfig(nextConfig: any): void {
    const configPath = this.getAdminConfigPath();
    fs.writeFileSync(
      configPath,
      JSON.stringify(nextConfig || {}, null, 2),
      "utf-8",
    );
  }

  private normalizeUserTagList(
    list: unknown,
  ): Array<{ name: string; visible: boolean }> {
    if (!Array.isArray(list)) return [];
    return list
      .map((item: any) => {
        if (typeof item === "string") {
          const name = item.trim();
          return name ? { name, visible: true } : null;
        }
        if (item && typeof item === "object") {
          const name = String(item.name || "").trim();
          if (!name) return null;
          return { name, visible: item.visible !== false };
        }
        return null;
      })
      .filter((item): item is { name: string; visible: boolean } => !!item);
  }

  private normalizeEquipmentOptionList(
    list: unknown,
  ): Array<{ name: string; visible: boolean }> {
    if (!Array.isArray(list)) return [];
    return list
      .map((item: any) => {
        if (typeof item === "string") {
          const name = item.trim();
          return name ? { name, visible: true } : null;
        }
        if (item && typeof item === "object") {
          const name = String(item.name || "").trim();
          if (!name) return null;
          return { name, visible: item.visible !== false };
        }
        return null;
      })
      .filter(
        (
          item: { name: string; visible: boolean } | null,
        ): item is { name: string; visible: boolean } => !!item,
      );
  }

  private normalizePricingOptionList(
    list: unknown,
  ): Array<{ key: string; label: string; visible: boolean }> {
    if (!Array.isArray(list)) return [];
    return list
      .map((item: any) => {
        if (typeof item === "string") {
          const key = item.trim();
          return key ? { key, label: key, visible: true } : null;
        }
        if (item && typeof item === "object") {
          const key = String(item.key || item.label || "").trim();
          if (!key) return null;
          const label = String(item.label || key).trim() || key;
          return { key, label, visible: item.visible !== false };
        }
        return null;
      })
      .filter(
        (
          item: { key: string; label: string; visible: boolean } | null,
        ): item is { key: string; label: string; visible: boolean } => !!item,
      );
  }

  private normalizeCampaignTypeConfigs(
    list: unknown,
  ): CampaignTypeConfigItem[] {
    return resolveCampaignTypeConfigs(list);
  }

  constructor(
    @InjectModel("Tier") private readonly tierModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("CampaignInvite")
    private readonly campaignInviteModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {
    // Load plans-config.json on initialization
    this.loadPlansConfig();
  }

  private loadPlansConfig() {
    try {
      let configPath = path.join(__dirname, "../assets/plans-config.json");
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.cwd(), "assets/plans-config.json");
      }
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        this.plansConfig = JSON.parse(raw);
        console.log("Loaded plans-config.json");
      } else {
        console.warn("plans-config.json not found");
      }
    } catch (err) {
      console.error("Error loading plans-config.json:", err);
    }
  }

  private getCommissionDefaults() {
    if (this.plansConfig?.commission) {
      return this.plansConfig.commission;
    }
    // Fallback defaults if config not loaded
    return {
      platformFeeEnabled: false,
      platformFeePercent: 10,
      gstPercent: 18,
      earlyAccessCommissionPercent: 0,
      partnerCommissionPercent: 2,
      internalTestCommissionPercent: 0,
    };
  }

  @Get("settings")
  async getSettings() {
    // Get commission defaults from plans-config
    const commissionDefaults = this.getCommissionDefaults();

    // These are the base defaults from the schema
    const defaults = {
      preApproveInfluencers: false,
      influencerRequireEmailVerified: true,
      influencerRequireMobileVerified: false,
      preApproveBrands: false,
      brandRequireEmailVerified: true,
      brandRequireMobileVerified: false,
      preApprovePhotographers: false,
      photographerRequireEmailVerified: true,
      photographerRequireMobileVerified: false,
      pendingUserAutoDeleteEnabled: false,
      pendingUserAutoDeleteDays: 45,
      pendingUserAutoDeleteLastRunAt: null,
      pendingUserAutoDeleteLastRunCount: 0,
      pendingUserAutoDeleteLastRunBy: "",
      campaignApprovalMode: "manual",
      collaborationApprovalMode: "manual",
      platformFeeEnabled: false,
      platformFeePercent: commissionDefaults.platformFeePercent,
      gstPercent: commissionDefaults.gstPercent,
      earlyAccessAssignmentMode: "manual",
      earlyAccessLastRunAt: null,
      earlyAccessLastRunStatus: "",
      earlyAccessLastRunDetails: "",
      earlyAccessLastRunMode: "",
      earlyAccessCommissionPercent:
        commissionDefaults.earlyAccessCommissionPercent,
      partnerCommissionPercent: commissionDefaults.partnerCommissionPercent,
      internalTestCommissionPercent:
        commissionDefaults.internalTestCommissionPercent,
      supportContactEnabled: true,
      supportContactEmail: "support@trendstarz.in",
      supportContactPhone: "",
      supportContactWhatsapp: "",
      verificationCallNumber: "",
      supportContactMessage:
        "For now, please contact our team to complete campaign payments. Our admin will update the payment status once received.",
      showSearchLink: true,
      showRegisterInfluencerLink: true,
      showRegisterBrandLink: true,
      showRegisterPhotographerLink: true,
      campaignTypeConfigs: getCampaignTypeConfigDefaults(),
    };
    const settings = await this.appSettingsModel.findOne({}).lean();
    const merged: any = { ...defaults, ...(settings || {}) };
    merged.campaignTypeConfigs = this.normalizeCampaignTypeConfigs(
      merged.campaignTypeConfigs,
    );
    merged.campaignTypeConfigDefaults = getCampaignTypeConfigDefaults();
    return merged;
  }

  @Patch("settings")
  async updateSettings(@Body() body: Record<string, any>) {
    const next: Record<string, any> = { ...body };
    if (next.campaignApprovalMode !== undefined) {
      const mode = String(next.campaignApprovalMode || "").trim();
      if (!["manual", "auto_live"].includes(mode)) {
        throw new BadRequestException(
          "campaignApprovalMode must be manual or auto_live",
        );
      }
      next.campaignApprovalMode = mode;
    }
    if (next.collaborationApprovalMode !== undefined) {
      const mode = String(next.collaborationApprovalMode || "").trim();
      if (!["manual", "auto_live"].includes(mode)) {
        throw new BadRequestException(
          "collaborationApprovalMode must be manual or auto_live",
        );
      }
      next.collaborationApprovalMode = mode;
    }
    if (next.earlyAccessAssignmentMode !== undefined) {
      const mode = String(next.earlyAccessAssignmentMode || "").trim();
      if (!["manual", "auto"].includes(mode)) {
        throw new BadRequestException(
          "earlyAccessAssignmentMode must be manual or auto",
        );
      }
      next.earlyAccessAssignmentMode = mode;
    }
    if (next.pendingUserAutoDeleteEnabled !== undefined) {
      next.pendingUserAutoDeleteEnabled = !!next.pendingUserAutoDeleteEnabled;
    }
    if (next.pendingUserAutoDeleteDays !== undefined) {
      const days = Number(next.pendingUserAutoDeleteDays);
      if (!Number.isFinite(days) || days < 1 || days > 3650) {
        throw new BadRequestException(
          "pendingUserAutoDeleteDays must be a number between 1 and 3650",
        );
      }
      next.pendingUserAutoDeleteDays = Math.floor(days);
    }
    if (next.campaignTypeConfigs !== undefined) {
      next.campaignTypeConfigs = this.normalizeCampaignTypeConfigs(
        next.campaignTypeConfigs,
      );
    }
    // Only update fields present in the request body
    const settings = await this.appSettingsModel
      .findOneAndUpdate({}, { $set: next }, { upsert: true, new: true })
      .lean();
    return { success: true, settings };
  }

  @Get("campaigns")
  async getCampaignsForApproval(
    @Query("status") status?: string,
    @Query("ownerType") ownerType?: string,
  ) {
    const normalized = String(status || "pending_review")
      .trim()
      .toLowerCase();
    const allowed = new Set([
      "pending_review",
      "needs_changes",
      "rejected",
      "active",
      "completed",
      "draft",
      "pending",
      "all",
    ]);

    const filter: any = {};
    if (allowed.has(normalized) && normalized !== "all") {
      filter.status = normalized;
    }

    const normalizedOwnerType = String(ownerType || "")
      .trim()
      .toLowerCase();
    if (normalizedOwnerType === "photographer") {
      // Photographer queue should include explicit ownerType plus legacy rows keyed by createdByRole.
      filter.$or = [
        { ownerType: "photographer" },
        { createdByRole: "photographer" },
      ];
    } else if (normalizedOwnerType === "brand") {
      // Brand queue should include legacy rows where ownerType was not persisted.
      filter.$or = [
        { ownerType: "brand" },
        { ownerType: { $exists: false } },
        { ownerType: null },
        { ownerType: "" },
      ];
    }

    const campaigns = await this.campaignModel
      .find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(300)
      .lean();

    const campaignIds = campaigns.map((c: any) => c?._id).filter(Boolean);
    const campaignIdKeys = campaignIds.map((id: any) => String(id));
    const inviteRows = campaignIds.length
      ? await this.campaignInviteModel
          .find({
            campaignId: {
              $in: [...campaignIds, ...campaignIdKeys],
            },
          })
          .select(
            "_id campaignId influencerId photographerId recipientRole status selectedPostDate updatedAt acceptedAt agreedAmount agreedAmountPaise counterOffer",
          )
          .lean()
      : [];

    const progressStatuses = new Set([
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "completed",
      "disputed",
    ]);
    const inviteStatsByCampaign = new Map<
      string,
      { inviteCount: number; hasInfluencerProgress: boolean }
    >();
    const inviteProgressByCampaign = new Map<string, any[]>();
    const influencerRecipientIds = new Set<string>();
    const photographerRecipientIds = new Set<string>();
    for (const invite of inviteRows) {
      const key = String(invite?.campaignId || "");
      if (!key) continue;
      const prev = inviteStatsByCampaign.get(key) || {
        inviteCount: 0,
        hasInfluencerProgress: false,
      };
      prev.inviteCount += 1;
      if (progressStatuses.has(String(invite?.status || "").toLowerCase())) {
        prev.hasInfluencerProgress = true;
      }
      inviteStatsByCampaign.set(key, prev);

      const recipientId = String(
        (invite as any)?.influencerId || (invite as any)?.photographerId || "",
      ).trim();
      if (!recipientId) continue;
      const recipientRole = String(invite?.recipientRole || "influencer")
        .trim()
        .toLowerCase();
      if (recipientRole === "photographer") {
        photographerRecipientIds.add(recipientId);
      } else {
        influencerRecipientIds.add(recipientId);
      }

      const progressRows = inviteProgressByCampaign.get(key) || [];
      const counter = (invite as any)?.counterOffer || {};
      progressRows.push({
        inviteId: String(invite?._id || ""),
        participantId: recipientId,
        participantRole: recipientRole === "photographer" ? "photographer" : "influencer",
        status: String(invite?.status || "pending").toLowerCase(),
        selectedPostDate: invite?.selectedPostDate || null,
        acceptedAt: invite?.acceptedAt || null,
        agreedAmount: Number((invite as any)?.agreedAmount || 0),
        agreedAmountPaise: Number((invite as any)?.agreedAmountPaise || 0),
        counterOfferStatus: String(counter?.status || "").toLowerCase(),
        counterOfferedAmount: Number(counter?.offeredAmount || 0),
        counterOfferedAmountPaise: Number(counter?.offeredAmountPaise || 0),
        counterRequestedAmount: Number(counter?.requestedAmount || 0),
        counterRequestedAmountPaise: Number(counter?.requestedAmountPaise || 0),
        updatedAt: invite?.updatedAt || null,
      });
      inviteProgressByCampaign.set(key, progressRows);
    }

    const inviteInfluencers = influencerRecipientIds.size
      ? await this.influencerModel
          .find({ _id: { $in: Array.from(influencerRecipientIds) } })
          .select("name username email profileImage profileImages")
          .lean()
      : [];
    const invitePhotographers = photographerRecipientIds.size
      ? await this.photographerModel
          .find({ _id: { $in: Array.from(photographerRecipientIds) } })
          .select("name username email profileImage profileImages")
          .lean()
      : [];
    const inviteInfluencerMap = new Map(
      inviteInfluencers.map((row: any) => [String(row?._id || ""), row]),
    );
    const invitePhotographerMap = new Map(
      invitePhotographers.map((row: any) => [String(row?._id || ""), row]),
    );

    const brandIds = Array.from(
      new Set(
        campaigns
          .filter((c: any) => String(c?.ownerType || "brand") === "brand")
          .map((c: any) => String(c.brandId || ""))
          .filter(Boolean),
      ),
    );
    const photographerIds = Array.from(
      new Set(
        campaigns
          .filter(
            (c: any) =>
              String(c?.ownerType || "").toLowerCase() === "photographer",
          )
          .map((c: any) => String(c.brandId || ""))
          .filter(Boolean),
      ),
    );
    const brands = await this.brandModel
      .find({ _id: { $in: brandIds } })
      .select("brandName brandUsername email verifiedByTrendStarz")
      .lean();
    const brandMap = new Map(brands.map((b: any) => [String(b._id), b]));
    const photographers = await this.photographerModel
      .find({ _id: { $in: photographerIds } })
      .select("name email profileImage profileImages verifiedByTrendStarz")
      .lean();
    const photographerMap = new Map(
      photographers.map((p: any) => [String(p._id), p]),
    );

    const rows = campaigns.map((campaign: any) => {
      const isPhotographerOwner =
        String(campaign?.ownerType || "").toLowerCase() === "photographer";
      const brand = isPhotographerOwner
        ? null
        : brandMap.get(String(campaign.brandId));
      const photographer = isPhotographerOwner
        ? photographerMap.get(String(campaign.brandId))
        : null;
      const stats = inviteStatsByCampaign.get(String(campaign._id)) || {
        inviteCount: 0,
        hasInfluencerProgress: false,
      };
      const rawInviteProgress =
        inviteProgressByCampaign.get(String(campaign._id)) || [];
      const inviteProgress = rawInviteProgress
        .map((row: any) => {
          const isPhotographer = row?.participantRole === "photographer";
          const profile = isPhotographer
            ? invitePhotographerMap.get(String(row?.participantId || ""))
            : inviteInfluencerMap.get(String(row?.participantId || ""));
          return {
            ...row,
            campaignAmountPaise: Number(
              campaign?.pricePerInfluencer || campaign?.amount || 0,
            ),
            participantName:
              String(
                profile?.name || profile?.username || "",
              ).trim() ||
              (isPhotographer ? "Photographer" : "Influencer"),
            participantEmail: String(profile?.email || "").trim() || null,
          };
        })
        .sort((a: any, b: any) => {
          const ta = new Date(a?.updatedAt || 0).getTime();
          const tb = new Date(b?.updatedAt || 0).getTime();
          return tb - ta;
        });
      return {
        ...campaign,
        ownerType: isPhotographerOwner ? "photographer" : "brand",
        inviteCount: stats.inviteCount,
        hasInfluencerProgress: stats.hasInfluencerProgress,
        inviteProgress,
        brand: isPhotographerOwner
          ? photographer
            ? {
                _id: photographer._id,
                brandName: photographer.name,
                brandUsername: null,
                email: photographer.email,
                verifiedByTrendStarz: !!photographer.verifiedByTrendStarz,
                profileImage:
                  photographer.profileImage ||
                  photographer.profileImages?.[0]?.url ||
                  null,
              }
            : null
          : brand
            ? {
                _id: brand._id,
                brandName: brand.brandName,
                brandUsername: brand.brandUsername,
                email: brand.email,
                verifiedByTrendStarz: !!brand.verifiedByTrendStarz,
              }
            : null,
      };
    });

    return { success: true, data: rows };
  }

  @Patch("campaigns/:id/moderation")
  async moderateCampaign(
    @Param("id") id: string,
    @Body()
    body: {
      action?: "approve" | "reject" | "needs_changes";
      moderationNote?: string;
    },
    @Req() req: any,
  ) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) {
      throw new BadRequestException("Campaign not found");
    }

    const action = String(body?.action || "")
      .trim()
      .toLowerCase();
    const map: Record<string, string> = {
      approve: "active",
      reject: "rejected",
      needs_changes: "needs_changes",
    };
    const nextStatus = map[action];
    if (!nextStatus) {
      throw new BadRequestException(
        "action must be approve, reject, or needs_changes",
      );
    }

    if (action === "reject" || action === "needs_changes") {
      const lockStatuses = [
        "accepted",
        "payment_confirmed",
        "working",
        "submitted",
        "completed",
        "disputed",
      ];
      const progressedInvite = await this.campaignInviteModel
        .findOne({
          campaignId: { $in: [campaign._id, String(campaign._id)] },
          status: { $in: lockStatuses },
        })
        .select("_id")
        .lean();
      if (progressedInvite) {
        throw new BadRequestException(
          "Cannot reject or request changes after influencer work has started on this campaign.",
        );
      }
    }

    campaign.status = nextStatus;
    campaign.moderationNote = String(body?.moderationNote || "").trim();
    campaign.moderatedBy = String(
      req?.user?.userId || req?.user?.id || "admin",
    );
    campaign.moderatedAt = new Date();

    const saved = await campaign.save();
    return { success: true, campaign: saved };
  }
  // Debug endpoint to log influencer and brand data
  @Get("debug-users")
  async debugUsers() {
    if (process.env.NODE_ENV === "production") {
      throw new BadRequestException("Debug endpoint is disabled in production");
    }
    try {
      const influencers = await this.influencerModel.find({}).lean().limit(5);
      const brands = await this.brandModel.find({}).lean().limit(5);
      return { influencers, brands };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Error fetching debug user data";
      throw new BadRequestException(message);
    }
  }
  // Debug endpoint to check stored public_ids for a specific user (for Cloudinary deletion troubleshooting)
  @Get("debug-user-images/:id")
  async debugUserImages(@Param("id") id: string) {
    if (process.env.NODE_ENV === "production") {
      throw new BadRequestException("Debug endpoint is disabled in production");
    }
    let user: any = await this.influencerModel.findById(id).lean();
    if (user) {
      return {
        type: "influencer",
        profileImages: (user.profileImages || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
      };
    }
    user = await this.brandModel.findById(id).lean();
    if (user) {
      return {
        type: "brand",
        brandLogo: (user.brandLogo || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
        products: (user.products || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
      };
    }
    return { message: "User not found", id };
  }

  // Admin dashboard endpoints for influencers and brands
  @Get("influencers")
  async getAllInfluencers(@Query("status") status?: string) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = true;
    } else if (status) {
      filter.status = status;
      filter.isDeleted = { $ne: true };
    } else {
      filter.isDeleted = { $ne: true };
    }
    const docs = await this.influencerModel.find(filter).lean().limit(200);
    const now = new Date();
    const normalized = (docs || []).map((doc: any) => {
      const hasActivePremium =
        !!doc?.isPremium &&
        (!doc?.premiumEnd || new Date(doc.premiumEnd) >= now);
      return { ...doc, isPremium: hasActivePremium };
    });
    return { success: true, data: normalized };
  }

  @Get("brands")
  async getAllBrands(@Query("status") status?: string) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = true;
    } else if (status) {
      filter.status = status;
      filter.isDeleted = { $ne: true };
    } else {
      filter.isDeleted = { $ne: true };
    }
    const docs = await this.brandModel.find(filter).lean().limit(200);
    const now = new Date();
    const normalized = (docs || []).map((doc: any) => {
      const hasActivePremium =
        !!doc?.isPremium &&
        (!doc?.premiumEnd || new Date(doc.premiumEnd) >= now);
      return { ...doc, isPremium: hasActivePremium };
    });
    return { success: true, data: normalized };
  }

  @Get("photographers")
  async getAllPhotographers(@Query("status") status?: string) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = true;
    } else if (status) {
      filter.status = status;
      filter.isDeleted = { $ne: true };
    } else {
      filter.isDeleted = { $ne: true };
    }
    const docs = await this.photographerModel.find(filter).lean().limit(200);
    const now = new Date();
    const normalized = (docs || []).map((doc: any) => {
      const hasActivePremium =
        !!doc?.isPremium &&
        (!doc?.premiumEnd || new Date(doc.premiumEnd) >= now);
      return { ...doc, isPremium: hasActivePremium };
    });
    return { success: true, data: normalized };
  }

  @Patch("states/:id")
  async patchState(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.stateModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("categories/:id")
  async patchCategory(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.categoryModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("languages/:id")
  async patchLanguage(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.languageModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("social-media/:id")
  async patchSocialMedia(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.socialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Patch("tiers/:id")
  async patchTier(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tierModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Get("tiers")
  async getTiers() {
    return this.tierModel.find().lean().limit(100);
  }

  // Categories
  @Get("categories")
  async getCategories(@Query("role") role?: string) {
    const normalizedRole = [
      "influencer",
      "brand",
      "photographer",
      "both",
    ].includes(String(role || "").toLowerCase())
      ? String(role).toLowerCase()
      : "";

    const filter: any = {};
    if (normalizedRole && normalizedRole !== "both") {
      filter.$or = [
        { role: normalizedRole },
        { role: "both" },
        { role: { $exists: false } },
      ];
    }

    return this.categoryModel
      .find(filter)
      .sort({ sortIndex: 1, name: 1 })
      .lean()
      .limit(200);
  }
  @Post("categories")
  async addCategory(
    @Body()
    body: {
      name: string;
      role?: "influencer" | "brand" | "photographer" | "both";
    },
  ) {
    return this.categoryModel.create(body);
  }
  @Put("categories/:id")
  async updateCategoryFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.categoryModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("categories/:id")
  async deleteCategory(@Param("id") id: string) {
    return this.categoryModel.findByIdAndDelete(id);
  }

  // States
  @Get("states")
  async getStates() {
    const totalStates = await this.stateModel.countDocuments();
    if (totalStates === 0) {
      await seedMissingLocationsFromConfig(this.stateModel, this.districtModel);
    }
    return this.stateModel.find().lean().limit(100);
  }
  @Post("states")
  async addState(@Body() body: { name: string }) {
    return this.stateModel.create(body);
  }
  @Put("states/:id")
  async updateStateFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.stateModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("states/:id")
  async deleteState(@Param("id") id: string) {
    return this.stateModel.findByIdAndDelete(id);
  }

  // Districts
  @Get("districts")
  async getDistricts(
    @Query("state") state?: string,
    @Query("stateId") stateId?: string,
  ) {
    const [totalStates, totalDistricts] = await Promise.all([
      this.stateModel.countDocuments(),
      this.districtModel.countDocuments(),
    ]);
    if (totalStates === 0 || totalDistricts === 0) {
      await seedMissingLocationsFromConfig(this.stateModel, this.districtModel);
    }

    let resolvedState = (state || "").trim();

    if (!resolvedState && stateId) {
      const stateDoc: any = await this.stateModel.findById(stateId).lean();
      resolvedState = String(stateDoc?.name || "").trim();
    }

    const filter: any = {};
    if (resolvedState) {
      const escaped = resolvedState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.state = new RegExp(`^${escaped}$`, "i");
    }

    return this.districtModel.find(filter).lean().limit(1000);
  }
  @Post("districts")
  async addDistrict(@Body() body: { name: string; state: string }) {
    return this.districtModel.create(body);
  }
  @Patch("districts/:id")
  async patchDistrict(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.districtModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Put("districts/:id")
  async updateDistrictFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.districtModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("districts/:id")
  async deleteDistrict(@Param("id") id: string) {
    return this.districtModel.findByIdAndDelete(id);
  }

  // Languages
  @Get("languages")
  async getLanguages() {
    return this.languageModel.find().lean().limit(100);
  }
  @Post("languages")
  async addLanguage(@Body() body: { name: string }) {
    return this.languageModel.create(body);
  }
  @Put("languages/:id")
  async updateLanguageFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.languageModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("languages/:id")
  async deleteLanguage(@Param("id") id: string) {
    return this.languageModel.findByIdAndDelete(id);
  }

  // Social Media
  @Get("social-media")
  async getSocialMedia() {
    // Return all social media entries including visibility flag for admin toggles.
    return this.socialMediaModel
      .find(
        {},
        {
          name: 1,
          socialMedia: 1,
          handleName: 1,
          tier: 1,
          followersCount: 1,
          showInFrontend: 1,
        },
      )
      .lean()
      .limit(100);
  }
  @Post("social-media")
  async addSocialMedia(
    @Body()
    body: {
      socialMedia: string;
      handleName: string;
      tier: string;
      followersCount: number;
    },
  ) {
    // Create new social media entry with all fields
    return this.socialMediaModel.create(body);
  }
  @Put("social-media/:id")
  async updateSocialMediaFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.socialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("social-media/:id")
  async deleteSocialMedia(@Param("id") id: string) {
    return this.socialMediaModel.findByIdAndDelete(id);
  }

  @Get("equipment-options")
  async getEquipmentOptionsAdmin() {
    const config = this.readAdminConfig();
    return this.normalizeEquipmentOptionList(config?.equipmentOptions);
  }

  @Get("pricing-options")
  async getPricingOptionsAdmin() {
    const config = this.readAdminConfig();
    return this.normalizePricingOptionList(config?.pricingOptions);
  }

  @Post("batch-update-visibility")
  async batchUpdateVisibility(@Body() body: BatchVisibilityBody) {
    try {
      // Each key is an array of {_id, showInFrontend}
      if (body.tiers) {
        for (const t of body.tiers) {
          const result = await this.tierModel.findByIdAndUpdate(t._id, {
            showInFrontend: t.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Tier not found: ${t._id}`);
          }
        }
      }
      if (body.socialMedia) {
        for (const s of body.socialMedia) {
          const result = await this.socialMediaModel.findByIdAndUpdate(s._id, {
            showInFrontend: s.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`SocialMedia not found: ${s._id}`);
          }
        }
      }
      if (body.categories) {
        for (const c of body.categories) {
          const result = await this.categoryModel.findByIdAndUpdate(c._id, {
            showInFrontend: c.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Category not found: ${c._id}`);
          }
        }
      }
      if (body.languages) {
        for (const l of body.languages) {
          const result = await this.languageModel.findByIdAndUpdate(l._id, {
            showInFrontend: l.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Language not found: ${l._id}`);
          }
        }
      }
      const hiddenStateNames = new Set<string>();
      if (body.states) {
        for (const s of body.states) {
          const result: any = await this.stateModel.findByIdAndUpdate(
            s._id,
            { showInFrontend: s.showInFrontend },
            { new: true },
          );
          if (!result) {
            console.error(`[BatchUpdate][ERROR] State not found:`, s);
            throw new BadRequestException(`State not found: ${s._id}`);
          }
          if (s.showInFrontend === false) {
            hiddenStateNames.add(String(result.name || "").trim().toLowerCase());
          }
        }
      }
      if (body.districts) {
        for (const d of body.districts) {
          const result = await this.districtModel.findByIdAndUpdate(d._id, {
            showInFrontend: d.showInFrontend,
          });
          if (!result) {
            console.error(`[BatchUpdate][ERROR] District not found:`, d);
            throw new BadRequestException(`District not found: ${d._id}`);
          }
        }
      }
      if (hiddenStateNames.size) {
        const hiddenStateRegexes = Array.from(hiddenStateNames)
          .filter(Boolean)
          .map((state) => new RegExp(`^${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
        if (hiddenStateRegexes.length) {
          await this.districtModel.updateMany(
            { state: { $in: hiddenStateRegexes } },
            { $set: { showInFrontend: false } },
          );
        }
      }
      const needsConfigUpdate =
        !!body.userTags || !!body.equipmentOptions || !!body.pricingOptions;

      if (needsConfigUpdate) {
        const currentConfig = this.readAdminConfig();
        const nextConfig = { ...currentConfig };

        if (body.userTags) {
          nextConfig.userTags = {
            influencer: this.normalizeUserTagList(
              body.userTags.influencer ?? currentConfig?.userTags?.influencer,
            ),
            brand: this.normalizeUserTagList(
              body.userTags.brand ?? currentConfig?.userTags?.brand,
            ),
            photographer: this.normalizeUserTagList(
              body.userTags.photographer ??
                currentConfig?.userTags?.photographer,
            ),
            commission: this.normalizeUserTagList(
              body.userTags.commission ?? currentConfig?.userTags?.commission,
            ),
          };
        }

        if (body.equipmentOptions) {
          nextConfig.equipmentOptions = this.normalizeEquipmentOptionList(
            body.equipmentOptions,
          );
        }

        if (body.pricingOptions) {
          nextConfig.pricingOptions = this.normalizePricingOptionList(
            body.pricingOptions,
          );
        }

        this.writeAdminConfig(nextConfig);
      }
      return { message: "Visibility updated" };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Error updating visibility";
      throw new BadRequestException(message);
    }
  }

  @Get("user-tags-config")
  async getUserTagsConfig() {
    const config = this.readAdminConfig();
    const userTags = config?.userTags || {};
    return {
      influencer: this.normalizeUserTagList(userTags.influencer),
      brand: this.normalizeUserTagList(userTags.brand),
      photographer: this.normalizeUserTagList(userTags.photographer),
      commission: this.normalizeUserTagList(userTags.commission),
    };
  }

  // ============ Commission Override Management ============

  /**
   * Get commission override for a user (influencer or brand)
   */
  @Get("commission-override/:userType/:userId")
  async getCommissionOverride(
    @Param("userType") userType: string,
    @Param("userId") userId: string,
  ) {
    const normalizedType = String(userType || "")
      .trim()
      .toLowerCase();
    if (!["influencer", "brand"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer' or 'brand'");
    }

    const model =
      normalizedType === "influencer" ? this.influencerModel : this.brandModel;

    const user: any = await model
      .findById(userId)
      .select("commissionOverride commissionBadge")
      .lean();

    if (!user) {
      throw new BadRequestException(`User not found: ${userId}`);
    }

    return {
      userId,
      userType: normalizedType,
      override: user.commissionOverride || {
        enabled: false,
        overrideType: "discount",
        value: 0,
        validFrom: null,
        validUntil: null,
        notes: "",
      },
      badge: user.commissionBadge || null,
    };
  }

  /**
   * Set commission override for a user
   * Body:
   * {
   *   enabled: boolean,
   *   overrideType: "waiver" | "discount" | "fixed",
   *   value: number (percentage for discount/fixed, or discount % off for discount),
   *   validFrom: date (optional),
   *   validUntil: date (optional),
   *   notes: string (optional),
   *   badge: string (optional - influencer or brand badge)
   * }
   */
  @Put("commission-override/:userType/:userId")
  async setCommissionOverride(
    @Param("userType") userType: string,
    @Param("userId") userId: string,
    @Body()
    body: {
      enabled?: boolean;
      overrideType?: "waiver" | "discount" | "fixed";
      value?: number;
      validFrom?: string;
      validUntil?: string;
      notes?: string;
      badge?: string;
    },
  ) {
    const normalizedType = String(userType || "")
      .trim()
      .toLowerCase();
    if (!["influencer", "brand"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer' or 'brand'");
    }

    const model =
      normalizedType === "influencer" ? this.influencerModel : this.brandModel;

    // Validate override type
    if (
      body.overrideType &&
      !["waiver", "discount", "fixed"].includes(body.overrideType)
    ) {
      throw new BadRequestException(
        "overrideType must be 'waiver', 'discount', or 'fixed'",
      );
    }

    // Validate value
    if (body.value !== undefined && (body.value < 0 || body.value > 100)) {
      throw new BadRequestException("value must be between 0 and 100");
    }

    // Validate dates
    if (body.validFrom) {
      const validFrom = new Date(body.validFrom);
      if (isNaN(validFrom.getTime())) {
        throw new BadRequestException("validFrom must be a valid date");
      }
    }
    if (body.validUntil) {
      const validUntil = new Date(body.validUntil);
      if (isNaN(validUntil.getTime())) {
        throw new BadRequestException("validUntil must be a valid date");
      }
    }

    const updateData: Record<string, any> = {};

    if (body.enabled !== undefined) {
      updateData["commissionOverride.enabled"] = body.enabled;
    }
    if (body.overrideType) {
      updateData["commissionOverride.overrideType"] = body.overrideType;
    }
    if (body.value !== undefined) {
      updateData["commissionOverride.value"] = body.value;
    }
    if (body.validFrom !== undefined) {
      updateData["commissionOverride.validFrom"] = body.validFrom
        ? new Date(body.validFrom)
        : null;
    }
    if (body.validUntil !== undefined) {
      updateData["commissionOverride.validUntil"] = body.validUntil
        ? new Date(body.validUntil)
        : null;
    }
    if (body.notes !== undefined) {
      updateData["commissionOverride.notes"] = body.notes;
    }
    if (body.badge !== undefined) {
      updateData["commissionBadge"] = body.badge || null;
    }

    const badgeLabelMap: Record<string, string> = {
      early_access_creator: "Early Access",
      partner_creator: "Partner",
      internal_test_creator: "Internal/Test",
      early_access_brand: "Early Access",
      partner_brand: "Partner",
      internal_test_brand: "Internal/Test",
      launch_partner: "Partner",
      zero_commission_creator: "Early Access",
      zero_commission_brand: "Early Access",
    };

    const currentUser = await model.findById(userId).select("adminTags").lean();
    if (!currentUser) {
      throw new BadRequestException(`User not found: ${userId}`);
    }

    const currentTags = Array.isArray((currentUser as any).adminTags)
      ? (currentUser as any).adminTags
      : [];

    if (body.badge !== undefined) {
      const commissionTagLabels = ["Early Access", "Partner", "Internal/Test"];
      const cleanedTags = currentTags.filter(
        (tag: string) =>
          !commissionTagLabels.includes(String(tag || "").trim()),
      );
      const mapped = body.badge ? badgeLabelMap[body.badge] : null;
      updateData["adminTags"] = mapped
        ? [...new Set([...cleanedTags, mapped])]
        : cleanedTags;
    }

    const user = await model.findByIdAndUpdate(userId, updateData, {
      new: true,
    });

    if (!user) {
      throw new BadRequestException(`User not found: ${userId}`);
    }

    return {
      success: true,
      userId,
      userType: normalizedType,
      override: user.commissionOverride,
      badge: user.commissionBadge,
    };
  }

  /**
   * Disable commission override for a user
   */
  @Delete("commission-override/:userType/:userId")
  async removeCommissionOverride(
    @Param("userType") userType: string,
    @Param("userId") userId: string,
  ) {
    const normalizedType = String(userType || "")
      .trim()
      .toLowerCase();
    if (!["influencer", "brand"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer' or 'brand'");
    }

    const model =
      normalizedType === "influencer" ? this.influencerModel : this.brandModel;

    const currentUser = await model.findById(userId).select("adminTags").lean();
    if (!currentUser) {
      throw new BadRequestException(`User not found: ${userId}`);
    }

    const currentTags = Array.isArray((currentUser as any).adminTags)
      ? (currentUser as any).adminTags
      : [];
    const commissionTagLabels = ["Early Access", "Partner", "Internal/Test"];
    const cleanedTags = currentTags.filter(
      (tag: string) => !commissionTagLabels.includes(String(tag || "").trim()),
    );

    await model.findByIdAndUpdate(
      userId,
      {
        commissionOverride: {
          enabled: false,
          overrideType: "discount",
          value: 0,
          validFrom: null,
          validUntil: null,
          notes: "",
        },
        commissionBadge: null,
        adminTags: cleanedTags,
      },
      { new: true },
    );

    return { success: true, message: "Commission override removed" };
  }

  /**
   * Get users by commission badge
   */
  @Get("users-by-commission-badge/:userType/:badge")
  async getUsersByCommissionBadge(
    @Param("userType") userType: string,
    @Param("badge") badge: string,
  ) {
    const normalizedType = String(userType || "")
      .trim()
      .toLowerCase();
    if (!["influencer", "brand"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer' or 'brand'");
    }

    const model =
      normalizedType === "influencer" ? this.influencerModel : this.brandModel;

    const users = await model
      .find({ commissionBadge: badge })
      .select(
        normalizedType === "influencer"
          ? "name email commissionBadge commissionOverride"
          : "brandName email commissionBadge commissionOverride",
      )
      .lean();

    return {
      userType: normalizedType,
      badge,
      count: users.length,
      users,
    };
  }
}
