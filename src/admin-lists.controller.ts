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
  getCampaignAccessModeConfigDefaults,
  CampaignTypeConfigItem,
  getCampaignTypeConfigDefaults,
  resolveCampaignAccessModeConfigs,
  resolveCampaignTypeConfigs,
} from "./campaign-type-configs";
import { seedMissingLocationsFromConfig } from "./utils/location-seed.util";
import {
  normalizeCollaborationOptionConfig,
  normalizeCreatorTypeConfig,
} from "./utils/collaboration-options.util";
import {
  normalizeCommunityStateKey,
  seedMissingWhatsAppCommunitiesFromConfig,
} from "./utils/whatsapp-community-config.util";
import { PendingUserCleanupService } from "./admin/pending-user-cleanup.service";
import { PendingUploadCleanupService } from "./admin/pending-upload-cleanup.service";
import { AssetFolderBackfillService } from "./admin/asset-folder-backfill.service";
import { CampaignsService } from "./campaigns/campaigns.service";
import {
  ACCEPTED_OR_LATER_STATUSES,
  SUBMITTED_OR_LATER_STATUSES,
  computeCampaignAlertFields,
  renderOpenCampaignMessage,
  renderInviteOnlyMessage,
  renderPostingReminderMessage,
  renderInviteAcceptedOwnerMessage,
  renderPostSubmittedOwnerMessage,
} from "./campaigns/campaign-alert-messages";

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
  creatorTypeOptions?: Array<{ name?: string; visible?: boolean }>;
  userTags?: {
    influencer?: Array<{ name: string; visible: boolean }>;
    brand?: Array<{ name: string; visible: boolean }>;
    photographer?: Array<{ name: string; visible: boolean }>;
    commission?: Array<{ name: string; visible: boolean }>;
  };
  collaborationAvailability?: any;
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

  private normalizeCampaignAccessModeConfigs(list: unknown) {
    return resolveCampaignAccessModeConfigs(list);
  }

  constructor(
    @InjectModel("Tier") private readonly tierModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("CampaignInvite")
    private readonly campaignInviteModel: Model<any>,
    @InjectModel("CampaignSubmission")
    private readonly campaignSubmissionModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly campaignTransactionModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("WhatsAppCommunity")
    private readonly whatsappCommunityModel: Model<any>,
    private readonly pendingUserCleanupService: PendingUserCleanupService,
    private readonly pendingUploadCleanupService: PendingUploadCleanupService,
    private readonly assetFolderBackfillService: AssetFolderBackfillService,
    private readonly campaignsService: CampaignsService,
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

  private getCampaignWorkflowTimingDefaults() {
    const config = this.readAdminConfig();
    const timing = config?.campaignWorkflowTiming || {};
    return {
      submissionApprovalWaitHours:
        typeof timing.submissionApprovalWaitHours === "number"
          ? timing.submissionApprovalWaitHours
          : 24,
      submissionAutoCompleteGraceHours:
        typeof timing.submissionAutoCompleteGraceHours === "number"
          ? timing.submissionAutoCompleteGraceHours
          : 48,
      payoutReleaseWaitHours:
        typeof timing.payoutReleaseWaitHours === "number"
          ? timing.payoutReleaseWaitHours
          : 24,
      disputeResponseWaitHours:
        typeof timing.disputeResponseWaitHours === "number"
          ? timing.disputeResponseWaitHours
          : 12,
      campaignAutoCloseGraceHours:
        typeof timing.campaignAutoCloseGraceHours === "number"
          ? timing.campaignAutoCloseGraceHours
          : 24,
    };
  }

  @Get("settings")
  async getSettings() {
    // Get commission defaults from plans-config
    const commissionDefaults = this.getCommissionDefaults();
    const workflowTimingDefaults = this.getCampaignWorkflowTimingDefaults();

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
      pendingUnverifiedReportLastRunAt: null,
      pendingUnverifiedReportLastRunCount: 0,
      pendingUnverifiedReportLastRunCounts: {
        influencers: 0,
        brands: 0,
        photographers: 0,
      },
      firebaseEmailSyncLastRunAt: null,
      firebaseEmailSyncLastRunCount: 0,
      firebaseEmailSyncLastRunBy: "",
      firebaseEmailSyncLastRunCounts: {
        admin: 0,
        influencer: 0,
        brand: 0,
        photographer: 0,
      },
      campaignApprovalMode: "manual",
      collaborationApprovalMode: "manual",
      minCampaignStartDays: 3,
      maxCampaignDurationDays: 15,
      paymentGatewayMode: "razorpay_fallback",
      platformFeeEnabled: false,
      platformFeePercent: commissionDefaults.platformFeePercent,
      brandFeePercent: null,
      influencerFeePercent: 0,
      photographerFeePercent: 0,
      influencerRecipientFeePercent: 0,
      photographerRecipientFeePercent: 0,
      brandRecipientFeePercent: 0,
      gstPercent: commissionDefaults.gstPercent,
      submissionApprovalWaitHours:
        workflowTimingDefaults.submissionApprovalWaitHours,
      submissionAutoCompleteGraceHours:
        workflowTimingDefaults.submissionAutoCompleteGraceHours,
      payoutReleaseWaitHours: workflowTimingDefaults.payoutReleaseWaitHours,
      disputeResponseWaitHours: workflowTimingDefaults.disputeResponseWaitHours,
      campaignAutoCloseGraceHours: workflowTimingDefaults.campaignAutoCloseGraceHours,
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
      otpVerificationEnabled: false,
      supportContactMessage:
        "For now, please contact our team to complete campaign payments. Our admin will update the payment status once received.",
      showSearchLink: true,
      showRegisterInfluencerLink: true,
      showRegisterBrandLink: true,
      showRegisterPhotographerLink: true,
      campaignAccessModeConfigs: getCampaignAccessModeConfigDefaults(),
      campaignTypeConfigs: getCampaignTypeConfigDefaults(),
    };
    const settings = await this.appSettingsModel.findOne({}).lean();
    const merged: any = { ...defaults, ...(settings || {}) };
    merged.campaignTypeConfigs = this.normalizeCampaignTypeConfigs(
      merged.campaignTypeConfigs,
    );
    merged.campaignAccessModeConfigs = this.normalizeCampaignAccessModeConfigs(
      merged.campaignAccessModeConfigs,
    );
    merged.campaignTypeConfigDefaults = getCampaignTypeConfigDefaults();
    merged.campaignAccessModeConfigDefaults =
      getCampaignAccessModeConfigDefaults();
    return merged;
  }

  private async getCommunityJoinedCounts(): Promise<Map<string, number>> {
    const models = [
      this.userModel,
      this.influencerModel,
      this.brandModel,
      this.photographerModel,
    ];
    const results = await Promise.all(
      models.map((model) =>
        model
          .aggregate([
            {
              $match: {
                communityJoined: true,
                communityName: { $exists: true, $nin: ["", null] },
              },
            },
            { $group: { _id: "$communityName", count: { $sum: 1 } } },
          ])
          .exec(),
      ),
    );
    const counts = new Map<string, number>();
    for (const group of results.flat()) {
      const key = String(group?._id || "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + Number(group?.count || 0));
    }
    return counts;
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
    if (next.paymentGatewayMode !== undefined) {
      const mode = String(next.paymentGatewayMode || "").trim();
      if (!["manual", "razorpay_fallback", "razorpay_only"].includes(mode)) {
        throw new BadRequestException(
          "paymentGatewayMode must be manual, razorpay_fallback, or razorpay_only",
        );
      }
      next.paymentGatewayMode = mode;
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
    for (const key of [
      "submissionApprovalWaitHours",
      "submissionAutoCompleteGraceHours",
      "payoutReleaseWaitHours",
      "disputeResponseWaitHours",
      "campaignAutoCloseGraceHours",
    ]) {
      if (next[key] === undefined) continue;
      const hours = Number(next[key]);
      if (!Number.isFinite(hours) || hours < 0 || hours > 720) {
        throw new BadRequestException(
          `${key} must be a number between 0 and 720`,
        );
      }
      next[key] = Math.round(hours * 100) / 100;
    }
    if (next.minCampaignStartDays !== undefined) {
      const days = Number(next.minCampaignStartDays);
      if (!Number.isFinite(days) || days < 0 || days > 30) {
        throw new BadRequestException(
          "minCampaignStartDays must be a number between 0 and 30",
        );
      }
      next.minCampaignStartDays = Math.floor(days);
    }
    if (next.maxCampaignDurationDays !== undefined) {
      const days = Number(next.maxCampaignDurationDays);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        throw new BadRequestException(
          "maxCampaignDurationDays must be a number between 1 and 365",
        );
      }
      next.maxCampaignDurationDays = Math.floor(days);
    }
    const roleSpecificFeeKeys = ["brandFeePercent", "influencerFeePercent", "photographerFeePercent"];
    for (const key of [
      "platformFeePercent",
      "brandFeePercent",
      "influencerFeePercent",
      "photographerFeePercent",
      "influencerRecipientFeePercent",
      "photographerRecipientFeePercent",
      "brandRecipientFeePercent",
      "gstPercent",
      "earlyAccessCommissionPercent",
      "partnerCommissionPercent",
      "internalTestCommissionPercent",
    ]) {
      if (next[key] === undefined) continue;
      // Role-specific fee can be null (meaning "use global platformFeePercent")
      if (roleSpecificFeeKeys.includes(key) && next[key] === null) continue;
      const percent = Number(next[key]);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new BadRequestException(
          `${key} must be a number between 0 and 100`,
        );
      }
      next[key] = Math.round(percent * 100) / 100;
    }
    if (next.campaignTypeConfigs !== undefined) {
      next.campaignTypeConfigs = this.normalizeCampaignTypeConfigs(
        next.campaignTypeConfigs,
      );
    }
    if (next.campaignAccessModeConfigs !== undefined) {
      next.campaignAccessModeConfigs = this.normalizeCampaignAccessModeConfigs(
        next.campaignAccessModeConfigs,
      );
    }
    // Only update fields present in the request body
    const settings = await this.appSettingsModel
      .findOneAndUpdate({}, { $set: next }, { upsert: true, new: true })
      .lean();
    return { success: true, settings };
  }

  @Get("pending-unverified-report")
  async getPendingUnverifiedReport(
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    return this.pendingUserCleanupService.getPendingUnverifiedReport(
      days || 7,
      limit || 25,
    );
  }

  @Post("firebase-email-sync/run")
  async runFirebaseEmailSync(@Req() req: any) {
    const actor =
      req?.user?.email || req?.user?.userId || req?.user?.sub || "admin";
    return this.pendingUserCleanupService.syncFirebaseVerifiedEmails(
      String(actor),
    );
  }

  // Lists what the pending-upload cleanup would delete, without deleting
  // anything — use this to sanity-check the retention window before turning
  // on `pendingUploadAutoDeleteEnabled`.
  @Get("pending-upload-cleanup/preview")
  async previewPendingUploadCleanup() {
    return this.pendingUploadCleanupService.runCleanupNow("admin_preview", true);
  }

  @Post("pending-upload-cleanup/run")
  async runPendingUploadCleanup(@Req() req: any) {
    const actor =
      req?.user?.email || req?.user?.userId || req?.user?.sub || "admin";
    return this.pendingUploadCleanupService.runCleanupNow(String(actor), false);
  }

  // One-time (re-runnable) repair for historically-relocated Cloudinary
  // assets whose `asset_folder` attribute never got synced to match their
  // real public_id path — see AssetFolderBackfillService for the full story.
  @Get("asset-folder-backfill/preview")
  async previewAssetFolderBackfill() {
    return this.assetFolderBackfillService.runBackfillNow(true);
  }

  @Post("asset-folder-backfill/run")
  async runAssetFolderBackfill() {
    return this.assetFolderBackfillService.runBackfillNow(false);
  }

  /**
   * Maps each status TAB (what the admin UI shows) to the raw DB `status`
   * values that belong to it — mirrors `normalizeReviewStatus()` in
   * campaign-review.component.ts so legacy aliases (e.g. "pending") still
   * land in the right tab when filtering server-side.
   */
  private static readonly CAMPAIGN_STATUS_TAB_ALIASES: Record<
    string,
    string[]
  > = {
    pending_review: ["pending_review", "pending"],
    needs_changes: ["needs_changes", "needschange", "changes_requested"],
    rejected: ["rejected", "reject"],
    active: ["active", "approved", "live"],
    completed: ["completed"],
    cancelled: ["cancelled"],
    draft: ["draft"],
  };

  @Get("campaigns")
  async getCampaignsForApproval(
    @Query("status") status?: string,
    @Query("ownerType") ownerType?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("q") q?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("id") id?: string,
  ) {
    const normalized = String(status || "pending_review")
      .trim()
      .toLowerCase();
    const statusAliases = AdminListsController.CAMPAIGN_STATUS_TAB_ALIASES;

    // ownerType-only conditions — used both for the status-tab counters (which
    // must stay scoped to the whole queue, not the active status/search/date
    // filters) and as the base for the actual paginated query below.
    const ownerAndConditions: any[] = [];
    const normalizedOwnerType = String(ownerType || "")
      .trim()
      .toLowerCase();
    if (normalizedOwnerType === "photographer") {
      // Photographer queue should include explicit ownerType plus legacy rows keyed by createdByRole.
      ownerAndConditions.push({
        $or: [{ ownerType: "photographer" }, { createdByRole: "photographer" }],
      });
    } else if (normalizedOwnerType === "brand") {
      // Brand queue should include legacy rows where ownerType was not persisted.
      ownerAndConditions.push({
        $or: [
          { ownerType: "brand" },
          { ownerType: { $exists: false } },
          { ownerType: null },
          { ownerType: "" },
        ],
      });
    }
    const ownerScopeFilter = ownerAndConditions.length
      ? { $and: ownerAndConditions }
      : {};

    const [statusCountRows, newPendingCount] = await Promise.all([
      this.campaignModel.aggregate([
        { $match: ownerScopeFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      this.campaignModel.countDocuments({
        $and: [
          ...ownerAndConditions,
          { status: { $in: statusAliases.pending_review } },
          { createdAt: { $gt: new Date(Date.now() - 86400000) } },
        ],
      }),
    ]);
    const rawStatusCounts = new Map<string, number>(
      statusCountRows.map((row: any) => [String(row?._id || ""), row.count]),
    );
    const countForTab = (tab: string) =>
      (statusAliases[tab] || [tab]).reduce(
        (sum, alias) => sum + (rawStatusCounts.get(alias) || 0),
        0,
      );
    const statusCounts = {
      pending_review: countForTab("pending_review"),
      needs_changes: countForTab("needs_changes"),
      rejected: countForTab("rejected"),
      active: countForTab("active"),
      draft: countForTab("draft"),
      completed: countForTab("completed"),
      all: statusCountRows.reduce(
        (sum: number, row: any) => sum + row.count,
        0,
      ),
    };

    // Full filter for the actual paginated fetch: ownerType + active status tab + search + date range.
    const andConditions: any[] = [...ownerAndConditions];
    const directId = String(id || "").trim();
    if (directId) {
      // Direct lookup (e.g. deep-linking in from the Disputes page) bypasses the status/search/date filters.
      andConditions.push({ _id: directId });
    }
    if (!directId && normalized !== "all" && statusAliases[normalized]) {
      andConditions.push({ status: { $in: statusAliases[normalized] } });
    }

    const searchQuery = !directId ? String(q || "").trim() : "";
    if (searchQuery) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const [matchingBrands, matchingPhotographers] = await Promise.all([
        normalizedOwnerType === "photographer"
          ? Promise.resolve([])
          : this.brandModel.find({ brandName: regex }).select("_id").lean(),
        normalizedOwnerType === "brand"
          ? Promise.resolve([])
          : this.photographerModel.find({ name: regex }).select("_id").lean(),
      ]);
      const ownerIds = [
        ...matchingBrands.map((b: any) => b._id),
        ...matchingPhotographers.map((p: any) => p._id),
      ];

      // Displayed campaign IDs are "CMP-<campaignNumber>" or, for legacy rows
      // without a campaignNumber, "CMP-<last 6 chars of _id>" (see
      // campaignIdLabel in referral-link.util.ts). Neither is a stored,
      // directly-searchable field, so a "CMP-..." query needs to be decoded
      // back into the field it actually maps to.
      const idMatch = searchQuery.match(/^cmp-([a-z0-9]+)$/i);
      const idOrConditions: any[] = [];
      if (idMatch) {
        const idSuffix = idMatch[1];
        if (/^\d+$/.test(idSuffix)) {
          idOrConditions.push({ campaignNumber: Number(idSuffix) });
        }
        if (/^[a-f0-9]{1,6}$/i.test(idSuffix)) {
          idOrConditions.push({
            $expr: {
              $eq: [
                { $toUpper: { $substrCP: [{ $toString: "$_id" }, 18, 6] } },
                idSuffix.toUpperCase(),
              ],
            },
          });
        }
      }

      andConditions.push({
        $or: [
          { title: regex },
          { campaignTitle: regex },
          ...(ownerIds.length ? [{ brandId: { $in: ownerIds } }] : []),
          ...idOrConditions,
        ],
      });
    }

    const fromDate = !directId ? String(dateFrom || "").trim() : "";
    const toDate = !directId ? String(dateTo || "").trim() : "";
    if (fromDate || toDate) {
      const range: any = {};
      if (fromDate) range.$gte = new Date(`${fromDate}T00:00:00`);
      if (toDate) range.$lte = new Date(`${toDate}T23:59:59.999`);
      andConditions.push({ createdAt: range });
    }

    const filter: any = andConditions.length ? { $and: andConditions } : {};

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 10));
    const skip = (pageNum - 1) * pageSize;

    const [campaigns, total] = await Promise.all([
      this.campaignModel
        .find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      this.campaignModel.countDocuments(filter),
    ]);

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
            "_id campaignId influencerId photographerId recipientRole status selectedPlatform selectedContentType selectedPostDate updatedAt acceptedAt paymentConfirmedAt agreedAmount agreedAmountPaise counterOffer",
          )
          .lean()
      : [];

    const [submissionRows, transactionRows] = campaignIds.length
      ? await Promise.all([
          this.campaignSubmissionModel
            .find({ campaignId: { $in: [...campaignIds, ...campaignIdKeys] } })
            .select("inviteId status reviewedAt autoCompletedAt submittedAt")
            .sort({ submittedAt: -1 })
            .lean(),
          this.campaignTransactionModel
            .find({ campaignId: { $in: [...campaignIds, ...campaignIdKeys] } })
            .select(
              "inviteId gateway gatewayOrderId gatewayPaymentId utrNumber payoutStatus payoutGatewayProvider payoutInitiatedAt payoutSettledAt payoutUtr payoutTransferId recipientPayout",
            )
            .lean(),
        ])
      : [[], []];
    // Sorted by submittedAt desc above, so the first one set per inviteId is the latest.
    const submissionByInvite = new Map<string, any>();
    for (const sub of submissionRows) {
      const key = String((sub as any)?.inviteId || "");
      if (key && !submissionByInvite.has(key)) submissionByInvite.set(key, sub);
    }
    const transactionByInvite = new Map<string, any>();
    for (const tx of transactionRows) {
      const key = String((tx as any)?.inviteId || "");
      if (key) transactionByInvite.set(key, tx);
    }

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
      const inviteIdKey = String(invite?._id || "");
      const submission = submissionByInvite.get(inviteIdKey) || null;
      const transaction = transactionByInvite.get(inviteIdKey) || null;
      progressRows.push({
        inviteId: inviteIdKey,
        participantId: recipientId,
        participantRole:
          recipientRole === "photographer" ? "photographer" : "influencer",
        status: String(invite?.status || "pending").toLowerCase(),
        selectedPlatform: String((invite as any)?.selectedPlatform || ""),
        selectedContentType: String((invite as any)?.selectedContentType || ""),
        selectedPostDate: invite?.selectedPostDate || null,
        acceptedAt: invite?.acceptedAt || null,
        paymentConfirmedAt: (invite as any)?.paymentConfirmedAt || null,
        agreedAmount: Number((invite as any)?.agreedAmount || 0),
        agreedAmountPaise: Number((invite as any)?.agreedAmountPaise || 0),
        counterOfferStatus: String(counter?.status || "").toLowerCase(),
        counterOfferedAmount: Number(counter?.offeredAmount || 0),
        counterOfferedAmountPaise: Number(counter?.offeredAmountPaise || 0),
        counterRequestedAmount: Number(counter?.requestedAmount || 0),
        counterRequestedAmountPaise: Number(counter?.requestedAmountPaise || 0),
        updatedAt: invite?.updatedAt || null,
        // Host (campaign owner) approval of the participant's submitted post.
        postSubmissionStatus: submission?.status || null,
        postApproved: submission?.status === "approved",
        postApprovedAt:
          submission?.reviewedAt || submission?.autoCompletedAt || null,
        submittedAt: submission?.submittedAt || null,
        // Payout to the participant for this invite.
        paymentGateway: transaction?.gateway || null,
        hostPaymentUtr: transaction?.utrNumber || null,
        hostPaymentGatewayOrderId: transaction?.gatewayOrderId || null,
        hostPaymentGatewayPaymentId: transaction?.gatewayPaymentId || null,
        payoutStatus: transaction?.payoutStatus || null,
        payoutGatewayProvider: transaction?.payoutGatewayProvider || null,
        payoutDate: transaction?.payoutSettledAt || null,
        payoutInitiatedAt: transaction?.payoutInitiatedAt || null,
        payoutUtr: transaction?.payoutUtr || null,
        payoutTransferId: transaction?.payoutTransferId || null,
        payoutAmountPaise: Number(transaction?.recipientPayout || 0),
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
      .select(
        "brandName brandUsername email verifiedByTrendStarz verificationStatus",
      )
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
              String(profile?.name || profile?.username || "").trim() ||
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
                // profileImages[0] is the live source of truth; profileImage is a
                // legacy field that can go stale after a re-upload/recrop.
                profileImage:
                  photographer.profileImages?.[0]?.url ||
                  photographer.profileImage ||
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
                verificationStatus: brand.verificationStatus || "not_submitted",
              }
            : null,
      };
    });

    return {
      success: true,
      data: rows,
      total,
      page: pageNum,
      limit: pageSize,
      statusCounts,
      newPendingCount,
    };
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
    // Marking a campaign complete is a host action (or the auto-complete cron
    // once the timeline ends with no work in flight) — admin moderation only
    // covers the approve/reject/needs_changes review workflow.
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

    const previousStatus = campaign.status;
    campaign.status = nextStatus;
    campaign.moderationNote = String(body?.moderationNote || "").trim();
    campaign.moderatedBy = String(
      req?.user?.userId || req?.user?.id || "admin",
    );
    campaign.moderatedAt = new Date();

    const saved = await campaign.save();
    this.campaignsService
      .handleStatusTransitionSideEffects(previousStatus, saved)
      .catch(() => {});
    return { success: true, campaign: saved };
  }

  /**
   * Canonical "campaign is live" copy for the review page's Ready-to-Share
   * panel — computed the same way as the automated WhatsApp send (see
   * campaign-alert-messages.ts) so the two can never drift.
   */
  @Get("campaigns/:id/share-messages")
  async getCampaignShareMessages(@Param("id") id: string) {
    const campaign = await this.campaignModel
      .findById(id)
      .select(
        "title targetState targetDistrict venueState venueDistrict inviteRecipientRole maxInfluencers inviteSlots acceptanceDeadline endDate timelineEnd minInfluencerTier timelineStart startDate",
      )
      .lean();
    if (!campaign) {
      throw new BadRequestException("Campaign not found");
    }
    const acceptedCount = await this.campaignInviteModel.countDocuments({
      campaignId: { $in: [id, (campaign as any)._id] },
      status: { $in: ACCEPTED_OR_LATER_STATUSES },
    });
    const fields = computeCampaignAlertFields(campaign, acceptedCount);
    return {
      openCampaignMessage: renderOpenCampaignMessage(fields),
      inviteOnlyMessage: renderInviteOnlyMessage(fields),
      postingReminderMessage: renderPostingReminderMessage(fields),
    };
  }

  /**
   * Per-invite "ready to share" copy for the host-facing events (invite
   * accepted / post submitted) — shown in the campaign preview modal next to
   * that participant's row. Computed the same way as the automated WhatsApp
   * send (see campaign-alert-messages.ts) so the two can never drift.
   */
  @Get("campaigns/invites/:inviteId/share-messages")
  async getInviteHostShareMessages(@Param("inviteId") inviteId: string) {
    const invite = await this.campaignInviteModel.findById(inviteId).lean();
    if (!invite) {
      throw new BadRequestException("Invite not found");
    }
    const isPhotographerRecipient =
      String((invite as any).recipientRole || "influencer") === "photographer";
    const recipientModel = isPhotographerRecipient
      ? this.photographerModel
      : this.influencerModel;

    const [campaign, recipient, brandOwner, photographerOwner] =
      await Promise.all([
        this.campaignModel
          .findById((invite as any).campaignId)
          .select("title")
          .lean(),
        recipientModel.findById((invite as any).influencerId).select("name").lean(),
        this.brandModel
          .findById((invite as any).brandId)
          .select("brandName name")
          .lean(),
        this.photographerModel
          .findById((invite as any).brandId)
          .select("name")
          .lean(),
      ]);

    const ownerName =
      (brandOwner as any)?.brandName ||
      (brandOwner as any)?.name ||
      (photographerOwner as any)?.name ||
      "there";
    const frontendBase = (
      process.env.FRONTEND_URL || "https://trendstarz.in"
    ).replace(/\/$/, "");
    const fields = {
      ownerName,
      recipientName:
        (recipient as any)?.name ||
        `A ${isPhotographerRecipient ? "photographer" : "influencer"}`,
      campaignTitle: (campaign as any)?.title || "your campaign",
      campaignUrl: `${frontendBase}/campaign-management`,
    };

    const status = String((invite as any).status || "");
    return {
      inviteAcceptedMessage: ACCEPTED_OR_LATER_STATUSES.includes(status)
        ? renderInviteAcceptedOwnerMessage(fields)
        : null,
      postSubmittedMessage: SUBMITTED_OR_LATER_STATUSES.includes(status)
        ? renderPostSubmittedOwnerMessage(fields)
        : null,
    };
  }

  private assertAdminOverrideReason(reason: unknown): string {
    const trimmed = String(reason || "").trim();
    if (trimmed.length < 10) {
      throw new BadRequestException(
        "Please provide a reason for this override (at least 10 characters).",
      );
    }
    return trimmed;
  }

  /**
   * Emergency admin override: force a stuck/problem active campaign straight
   * to completed, bypassing the normal host "End campaign" action and the
   * auto-complete cron's in-flight-work check. Use sparingly.
   */
  @Patch("campaigns/:id/force-complete")
  async forceCompleteCampaign(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) {
      throw new BadRequestException("Campaign not found");
    }
    if (campaign.status !== "active") {
      throw new BadRequestException(
        `Only active campaigns can be force-completed (current status: '${campaign.status}').`,
      );
    }
    const reason = this.assertAdminOverrideReason(body?.reason);
    const adminId = String(req?.user?.userId || req?.user?.id || "admin");
    const now = new Date();

    campaign.status = "completed";
    campaign.completedBy = "admin";
    campaign.completedAt = now;
    campaign.adminOverrideAction = "force_complete";
    campaign.adminOverrideReason = reason;
    campaign.adminOverrideBy = adminId;
    campaign.adminOverrideAt = now;

    const saved = await campaign.save();
    return { success: true, campaign: saved };
  }

  /**
   * Emergency admin override: cancel a campaign's still-pending/unconfirmed
   * invites (pending/invited/counter_sent/accepted). Invites already paid or
   * in progress (payment_confirmed/working/submitted/etc.) are left untouched
   * — this stops new acceptances, it doesn't pull the rug out from under
   * creators who are already being paid.
   */
  @Patch("campaigns/:id/cancel-participation")
  async cancelCampaignParticipation(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) {
      throw new BadRequestException("Campaign not found");
    }
    if (campaign.status !== "active") {
      throw new BadRequestException(
        `Only active campaigns can have participation cancelled (current status: '${campaign.status}').`,
      );
    }
    const reason = this.assertAdminOverrideReason(body?.reason);
    const adminId = String(req?.user?.userId || req?.user?.id || "admin");
    const now = new Date();

    const cancellableStatuses = [
      "pending",
      "invited",
      "counter_sent",
      "accepted",
    ];
    const { modifiedCount } = await this.campaignInviteModel.updateMany(
      {
        campaignId: { $in: [campaign._id, String(campaign._id)] },
        status: { $in: cancellableStatuses },
      },
      { $set: { status: "withdrawn" } },
    );

    campaign.status = "cancelled";
    campaign.adminOverrideAction = "cancel_participation";
    campaign.adminOverrideReason = reason;
    campaign.adminOverrideBy = adminId;
    campaign.adminOverrideAt = now;

    const saved = await campaign.save();
    return { success: true, campaign: saved, cancelledInvites: modifiedCount };
  }

  @Get("whatsapp-communities")
  async getWhatsAppCommunities() {
    await seedMissingWhatsAppCommunitiesFromConfig(this.whatsappCommunityModel);
    const [items, joinedCounts] = await Promise.all([
      this.whatsappCommunityModel
        .find({})
        .sort({ state: 1, communityName: 1 })
        .lean()
        .limit(500),
      this.getCommunityJoinedCounts(),
    ]);
    const data = items.map((item: any) => ({
      ...item,
      joinedUserCount:
        joinedCounts.get(String(item?.communityName || "").trim()) || 0,
    }));
    return { success: true, data };
  }

  @Post("whatsapp-communities")
  async createWhatsAppCommunity(@Body() body: any) {
    const state = String(body?.state || "").trim();
    const communityName = String(
      body?.communityName || body?.groupName || "",
    ).trim();
    const communityLink = String(
      body?.communityLink || body?.whatsappLink || "",
    ).trim();
    const stateKey = normalizeCommunityStateKey(state);
    if (!stateKey || !communityName || !communityLink) {
      throw new BadRequestException(
        "State, community name, and WhatsApp link are required.",
      );
    }
    const saved = await this.whatsappCommunityModel.findOneAndUpdate(
      { stateKey },
      {
        $set: {
          state,
          stateKey,
          communityName,
          communityLink,
          isActive: body?.isActive !== false,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return { success: true, data: saved };
  }

  @Patch("whatsapp-communities/:id")
  async updateWhatsAppCommunity(@Param("id") id: string, @Body() body: any) {
    const state = String(body?.state || "").trim();
    const communityName = String(
      body?.communityName || body?.groupName || "",
    ).trim();
    const communityLink = String(
      body?.communityLink || body?.whatsappLink || "",
    ).trim();
    const stateKey = normalizeCommunityStateKey(state);
    if (!stateKey || !communityName || !communityLink) {
      throw new BadRequestException(
        "State, community name, and WhatsApp link are required.",
      );
    }
    const updated = await this.whatsappCommunityModel.findByIdAndUpdate(
      id,
      {
        $set: {
          state,
          stateKey,
          communityName,
          communityLink,
          isActive: body?.isActive !== false,
        },
      },
      { new: true },
    );
    if (!updated) throw new BadRequestException("Community not found");
    return { success: true, data: updated };
  }

  @Delete("whatsapp-communities/:id")
  async deleteWhatsAppCommunity(@Param("id") id: string) {
    await this.whatsappCommunityModel.findByIdAndDelete(id);
    return { success: true };
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
            hiddenStateNames.add(
              String(result.name || "")
                .trim()
                .toLowerCase(),
            );
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
          .map(
            (state) =>
              new RegExp(
                `^${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                "i",
              ),
          );
        if (hiddenStateRegexes.length) {
          await this.districtModel.updateMany(
            { state: { $in: hiddenStateRegexes } },
            { $set: { showInFrontend: false } },
          );
        }
      }
      const needsConfigUpdate =
        !!body.userTags ||
        !!body.equipmentOptions ||
        !!body.pricingOptions ||
        !!body.creatorTypeOptions ||
        !!body.collaborationAvailability;

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

        if (body.creatorTypeOptions) {
          nextConfig.creatorTypeOptions = normalizeCreatorTypeConfig(
            body.creatorTypeOptions,
          );
        }

        if (body.collaborationAvailability) {
          nextConfig.collaborationAvailability =
            normalizeCollaborationOptionConfig(body.collaborationAvailability);
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

  @Get("collaboration-availability-config")
  async getCollaborationAvailabilityConfig() {
    const config = this.readAdminConfig();
    return normalizeCollaborationOptionConfig(
      config?.collaborationAvailability,
    );
  }

  @Get("creator-type-options-config")
  async getCreatorTypeOptionsConfig() {
    const config = this.readAdminConfig();
    return normalizeCreatorTypeConfig(config?.creatorTypeOptions);
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
    if (!["influencer", "brand", "photographer"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer', 'brand', or 'photographer'");
    }

    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "photographer"
          ? this.photographerModel
          : this.brandModel;

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
    if (!["influencer", "brand", "photographer"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer', 'brand', or 'photographer'");
    }

    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "photographer"
          ? this.photographerModel
          : this.brandModel;

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
      early_access_photographer: "Early Access",
      partner_photographer: "Partner",
      internal_test_photographer: "Internal/Test",
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
    if (!["influencer", "brand", "photographer"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer', 'brand', or 'photographer'");
    }

    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "photographer"
          ? this.photographerModel
          : this.brandModel;

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
    if (!["influencer", "brand", "photographer"].includes(normalizedType)) {
      throw new BadRequestException("userType must be 'influencer', 'brand', or 'photographer'");
    }

    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "photographer"
          ? this.photographerModel
          : this.brandModel;

    const selectFields =
      normalizedType === "brand"
        ? "brandName email commissionBadge commissionOverride"
        : "name email commissionBadge commissionOverride";

    const users = await model
      .find({ commissionBadge: badge })
      .select(selectFields)
      .lean();

    return {
      userType: normalizedType,
      badge,
      count: users.length,
      users,
    };
  }
}
