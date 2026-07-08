import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model, Types } from "mongoose";
import { PlansService } from "../plans/plans.service";
import { CloudinaryService } from "../cloudinary.service";
import { CloudinaryFolders } from "../cloudinary-folders";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  CampaignTypeConfigItem,
  resolveCampaignAccessModeConfigs,
  resolveCampaignTypeConfigs,
} from "../campaign-type-configs";
import { getRequiredFields } from "./campaign-required-fields";
import { sendAppEmail } from "../utils/app-email.service";
import {
  openCampaignLiveTemplate,
  inviteCampaignLiveTemplate,
} from "../email/templates/campaign.templates";
import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "../utils/profile-selection-limits.util";
import {
  PROFILE_PHOTO_SAFETY_FLAG_CODES,
  ProfileVerificationService,
  ProfileUserType,
} from "../profile-verification/profile-verification.service";
import { CampaignInvitesService } from "./campaign-invites.service";

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending", "pending_review", "active", "needs_changes"],
  pending: ["active", "draft", "needs_changes", "rejected"],
  pending_review: ["active", "needs_changes", "rejected", "draft"],
  needs_changes: ["pending_review", "active", "rejected", "draft"],
  rejected: ["pending_review", "draft"],
  // active → pending is kept for brand "pause"; pending_review is admin-only (not via brand update)
  active: ["pending", "completed"],
  completed: [],
};

const TIER_FILTERED_OPEN_ROLLOUT_AT = new Date("2026-05-05T00:00:00.000Z"); // Rolled out May 2026
const ENABLE_CAMPAIGN_LIVE_EMAILS = false; // comment this if need to send campaign notification emails
const PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES = [
  "PROFILE_PHOTO_PENDING_REVIEW",
  "PROFILE_PHOTO_MISSING",
  "PROFILE_PHOTO_SCREENSHOT",
  "PROFILE_PHOTO_CELEBRITY",
  "PROFILE_PHOTO_GROUP",
  "PROFILE_PHOTO_BLURRY",
  "PROFILE_PHOTO_LOGO",
  "PROFILE_PHOTO_LOW_QUALITY",
  "FACE_NOT_VISIBLE",
  "PROFILE_PHOTO_POLICY",
  "PROFILE_PHOTO_CONTACT_INFO",
  "PROFILE_PHOTO_QR_CODE",
];

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
    @InjectModel("CampaignInvite")
    private readonly campaignInviteModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("ProfileFlag") private readonly profileFlagModel: Model<any>,
    @InjectModel("Counter") private readonly counterModel: Model<any>,
    private readonly plansService: PlansService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly pushService: PushService,
    private readonly notificationsService: NotificationsService,
    private readonly profileVerificationService: ProfileVerificationService,
    private readonly campaignInvitesService: CampaignInvitesService,
  ) {}

  // Safety net for the manual "Mark Complete" action: once a campaign's timeline
  // has ended and none of its invites still have active work in flight, close it
  // out automatically so campaigns don't sit in Active/EXPIRED indefinitely.
  @Cron(CronExpression.EVERY_HOUR)
  async autoCompleteExpiredCampaignsCron() {
    await this.autoCompleteExpiredCampaigns();
  }

  private async getCampaignAutoCloseGraceHours(): Promise<number> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    const hours = Number(settings?.campaignAutoCloseGraceHours ?? 24);
    return Number.isFinite(hours) && hours >= 0 ? hours : 24;
  }

  async autoCompleteExpiredCampaigns() {
    const now = new Date();
    const graceHours = await this.getCampaignAutoCloseGraceHours();
    const graceCutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

    const candidates = await this.campaignModel
      .find({
        status: "active",
        $or: [{ endDate: { $lte: now } }, { timelineEnd: { $lte: now } }],
      })
      .select("_id endDate timelineEnd")
      .lean();

    const blockingStatuses = [
      "accepted",
      "payment_confirmed",
      "working",
      "submitted",
      "disputed",
    ];
    // Subset of the above that means "never submitted" — these are the only ones the grace-
    // period backstop actually expires. submitted/disputed resolve on their own independent
    // crons/admin action regardless of the campaign shell's status, so they're left alone.
    const neverSubmittedStatuses = ["accepted", "payment_confirmed", "working"];

    let completedCount = 0;
    for (const candidate of candidates) {
      const campaignId = candidate._id;
      // Math.max (not ||) across whichever end-date fields exist — a campaign can match the
      // query above via timelineEnd alone while endDate is still in the future (legacy rows/
      // partial updates); picking the wrong one would silently defeat the backstop.
      const endTimes = [candidate.endDate, candidate.timelineEnd]
        .filter(Boolean)
        .map((d: any) => new Date(d).getTime());
      const referenceEnd = endTimes.length ? Math.max(...endTimes) : now.getTime();
      const pastGrace = referenceEnd <= graceCutoff.getTime();

      const hasActiveWork = await this.campaignInviteModel
        .findOne({
          campaignId: { $in: [campaignId, String(campaignId)] },
          status: { $in: blockingStatuses },
        })
        .select("_id")
        .lean();

      if (hasActiveWork) {
        if (!pastGrace) continue;
        try {
          await this.campaignInvitesService.expireUnsubmittedInvitesForCampaign(
            String(campaignId),
            "Campaign's grace period ended with no submission.",
          );
        } catch (e) {
          console.error(
            "autoCompleteExpiredCampaigns: grace-period expiry failed",
            campaignId,
            e,
          );
          continue; // retry next hour — never lock 'completed' over a failed cleanup
        }
        // Re-verify only the never-submitted set — if expiry partially failed and one of
        // these is still stuck, don't complete yet (would orphan it with no way back).
        const stillBlocking = await this.campaignInviteModel
          .findOne({
            campaignId: { $in: [campaignId, String(campaignId)] },
            status: { $in: neverSubmittedStatuses },
          })
          .select("_id")
          .lean();
        if (stillBlocking) continue;
      }

      const result = await this.campaignModel.updateOne(
        { _id: campaignId, status: "active" },
        { $set: { status: "completed", completedBy: "auto", completedAt: now } },
      );
      if (result.modifiedCount) completedCount++;
    }

    return { success: true, checked: candidates.length, completedCount };
  }

  private async resolveInitialCampaignStatus(
    status: unknown,
    ownerType: CampaignOwnerType = "brand",
  ): Promise<string> {
    const requested = String(status || "")
      .trim()
      .toLowerCase();
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
    if (
      ["active", "pending_review", "pending", "needs_changes"].includes(
        requested,
      )
    ) {
      return "active";
    }
    return "active";
  }

  private async loadOwnerVerificationProfile(
    ownerId: string,
    ownerType: CampaignOwnerType,
  ) {
    const select =
      "status isEmailVerified isMobileVerified profileImages brandLogo location socialMedia products galleryImages portfolio verificationStatus verifiedByTrendStarz";
    if (ownerType === "photographer") {
      return this.photographerModel.findById(ownerId).select(select).lean();
    }
    return this.brandModel.findById(ownerId).select(select).lean();
  }

  /**
   * Campaign eligibility for the OWNER (Brand/Photographer posting a
   * campaign) — same bar as the recipient side (assertCampaignEligible in
   * profile-verification.service.ts): verified email/mobile, a complete
   * profile, and admin approval. Campaigns involve real work and payment, so
   * this is deliberately stricter than just being searchable.
   */
  private assertOwnerCanPost(profile: any, ownerType: CampaignOwnerType) {
    if (profile?.status !== "accepted") {
      throw new BadRequestException(
        "Your account is not active. Contact support before posting or sending campaign invitations.",
      );
    }
    if (
      profile?.isEmailVerified !== true ||
      profile?.isMobileVerified !== true
    ) {
      throw new BadRequestException(
        "Verify both email and mobile before posting or sending campaign invitations.",
      );
    }
    const userType: ProfileUserType =
      ownerType === "photographer" ? "Photographer" : "Brand";
    if (!this.profileVerificationService.isProfileComplete(profile, userType)) {
      throw new BadRequestException(
        userType === "Brand"
          ? "Complete your company profile (logo and location) before posting or sending campaign invitations."
          : "Complete your profile (photo, location, social tier, and portfolio) before posting or sending campaign invitations.",
      );
    }
    if (!this.profileVerificationService.isAdminApproved(profile)) {
      throw new BadRequestException(
        "Admin approval is required before posting or sending campaign invitations.",
      );
    }
  }

  private async assertOwnerPhotoSafetyClear(
    ownerId: string,
    ownerType: CampaignOwnerType,
  ) {
    const userType = ownerType === "photographer" ? "Photographer" : "Brand";
    const count = await this.profileFlagModel.countDocuments({
      userId: String(ownerId),
      userType,
      status: "Open",
      flagCode: { $in: [...PROFILE_PHOTO_SAFETY_FLAG_CODES] },
    });
    if (count > 0) {
      throw new BadRequestException(
        "Resolve profile photo policy issues before posting or sending campaign invitations.",
      );
    }
  }

  private async hasProfilePhotoVisibilityBlock(
    userId: string,
    userType: "Influencer" | "Photographer",
  ): Promise<boolean> {
    if (!userId) return true;
    const count = await this.profileFlagModel.countDocuments({
      userId: String(userId),
      userType,
      status: "Open",
      flagCode: { $in: PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES },
    });
    return count > 0;
  }

  private normalizeCampaignPayload(data: any, settings?: any) {
    const normalized: any = { ...data };
    const minStartDays = Number(settings?.minCampaignStartDays ?? 3);
    const maxDurationDays = Number(settings?.maxCampaignDurationDays ?? 15);

    if (data.campaignMode !== undefined && data.campaignMode !== null) {
      const mode = String(data.campaignMode);
      if (!["invite_only", "tier_filtered_open"].includes(mode)) {
        throw new BadRequestException(
          "campaignMode must be invite_only or tier_filtered_open",
        );
      }
      normalized.campaignMode = mode;
    }

    if (data.postingDeadlineMode !== undefined && data.postingDeadlineMode !== null) {
      const mode = String(data.postingDeadlineMode);
      if (!["grace_24h", "strict"].includes(mode)) {
        throw new BadRequestException(
          "postingDeadlineMode must be grace_24h or strict",
        );
      }
      normalized.postingDeadlineMode = mode;
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

    if (normalized.startDate) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const minStart = new Date(today.getTime() + minStartDays * 24 * 60 * 60 * 1000);
      if (new Date(normalized.startDate) < minStart) {
        throw new BadRequestException(
          `Start date must be at least ${minStartDays} days from today`,
        );
      }
    }

    if (normalized.startDate && normalized.endDate) {
      if (new Date(normalized.endDate) < new Date(normalized.startDate)) {
        throw new BadRequestException(
          "End date must be on or after start date",
        );
      }
      const maxDurationMs = maxDurationDays * 24 * 60 * 60 * 1000;
      if (
        new Date(normalized.endDate).getTime() -
          new Date(normalized.startDate).getTime() >
        maxDurationMs
      ) {
        throw new BadRequestException(
          `Campaign duration cannot exceed ${maxDurationDays} days`,
        );
      }
    }

    // Acceptance deadline is always derived automatically — end of day, one
    // day before the campaign start date — for both invite-only and open
    // campaigns. Any client-supplied value is ignored; it's only recomputed
    // when startDate is part of this create/update payload.
    if (normalized.startDate) {
      const start = new Date(normalized.startDate);
      normalized.acceptanceDeadline = new Date(
        Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth(),
          start.getUTCDate() - 1,
          23,
          59,
          59,
          999,
        ),
      );
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
      normalized.targetState = data.targetState
        ? String(data.targetState)
        : undefined;
    }
    if (data.targetDistrict !== undefined) {
      normalized.targetDistrict = data.targetDistrict
        ? String(data.targetDistrict)
        : undefined;
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
          const role = String(slot?.role || "")
            .trim()
            .toLowerCase();
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

    // Contact-info guard: description, deliverables, and specialInstructions
    // must not contain phone numbers, emails, URLs or messaging links.
    // Contact details are shared automatically after payment confirmation.
    const textFieldsToScan: Array<[string, string]> = [
      ["description", String(normalized.description || "")],
      ["specialInstructions", String(normalized.specialInstructions || "")],
    ];
    const deliverablesList: string[] = Array.isArray(normalized.deliverables)
      ? normalized.deliverables.map((d: any) => String(d || ""))
      : [];
    textFieldsToScan.push(["deliverables", deliverablesList.join(" ")]);

    for (const [field, value] of textFieldsToScan) {
      if (value && this.containsContactInfo(value)) {
        throw new BadRequestException(
          `${field} must not contain contact details (phone numbers, emails, URLs or messaging links). These are shared with creators automatically after user accepted/confirmed.`,
        );
      }
    }

    return normalized;
  }

  private containsContactInfo(text: string): boolean {
    if (!text) return false;
    const patterns = [
      /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
      /\b\d{10}\b|\+?91[\s\-]?\d{10}/,
      /https?:\/\/\S+|www\.\S+/i,
      /\bwhatsapp\b|\bwa\.me\b|\bt\.me\b|\btelegram\b/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private applyCampaignTargetCategoryLimit(
    payload: any,
    inviteRecipientRole: InviteRecipientRole,
  ): void {
    if (payload?.categories === undefined) return;
    const limit =
      inviteRecipientRole === "photographer"
        ? PROFILE_SELECTION_LIMITS.photographer.skills
        : PROFILE_SELECTION_LIMITS.influencer.categories;
    payload.categories = normalizeSelectionList(payload.categories, limit);
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

  private assertCampaignModeAvailability(
    data: any,
    hasPremium: boolean,
    settings: any,
  ) {
    const mode = String(data?.campaignMode || "invite_only");
    if (!["invite_only", "tier_filtered_open"].includes(mode)) {
      throw new BadRequestException("Invalid campaign access mode.");
    }
    const config = resolveCampaignAccessModeConfigs(
      settings?.campaignAccessModeConfigs,
    ).find((item) => item.key === mode);
    if (!config || !config.enabled) {
      throw new BadRequestException(
        "This campaign access mode is currently unavailable.",
      );
    }
    if (config.premiumOnly && !hasPremium) {
      throw new BadRequestException(
        "This campaign access mode requires a Premium plan. Upgrade to unlock it.",
      );
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
      campaignMode: String(payload?.campaignMode || ""),
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
    return String(value || "influencer")
      .trim()
      .toLowerCase() === "photographer"
      ? "photographer"
      : "influencer";
  }

  private resolveRequestKind(
    ownerType: CampaignOwnerType,
    inviteRecipientRole: InviteRecipientRole,
    currentRequestKind?: string,
  ): RequestKind {
    if (ownerType === "photographer") {
      return "photographer_collaboration";
    }
    if (ownerType === "influencer" && inviteRecipientRole === "photographer") {
      return "photographer_collaboration";
    }
    if (inviteRecipientRole === "photographer") {
      const normalizedCurrent = String(currentRequestKind || "")
        .trim()
        .toLowerCase();
      if (
        normalizedCurrent === "photographer_collaboration" ||
        normalizedCurrent === "videographer_collaboration"
      ) {
        return "photographer_collaboration";
      }
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
    return this.safeFindOne(this.influencerModel, { username: id }, "_id");
  }

  private async resolveOwnerTypeByProfile(
    ownerId: string,
    requesterRole?: string,
  ): Promise<CampaignOwnerType> {
    const normalizedRole = String(requesterRole || "")
      .trim()
      .toLowerCase();
    if (
      normalizedRole === "photographer" ||
      normalizedRole === "videographer"
    ) {
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
    // Enforce creation limit for owners (brand/photographer)
    const ownerType: CampaignOwnerType = await this.resolveOwnerTypeByProfile(
      ownerId,
      requesterRole,
    );
    const persistedOwnerType: CampaignOwnerType =
      ownerType === "influencer" ? "brand" : ownerType;
    // Drafts aren't posted or sent to anyone yet, so don't gate them behind
    // email/mobile verification — only enforce it once the campaign is
    // actually being submitted/published.
    const requestedStatus = String(data?.status || "")
      .trim()
      .toLowerCase();
    if (requestedStatus !== "draft") {
      const ownerProfile = await this.loadOwnerVerificationProfile(
        ownerId,
        persistedOwnerType,
      );
      this.assertOwnerCanPost(ownerProfile, persistedOwnerType);
      await this.assertOwnerPhotoSafetyClear(ownerId, persistedOwnerType);
    }
    // Lazy load PlansService to avoid circular dep
    const caps = await this.plansService.getUserPlanCapabilities(ownerId);
    const settings = await this.appSettingsModel.findOne({}).lean().exec();
    this.assertCampaignModeAvailability(data, caps.hasPremium, settings);
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
    const normalized = this.normalizeCampaignPayload(data, settings);
    if (
      !Number.isFinite(Number(normalized.maxInfluencers)) ||
      Number(normalized.maxInfluencers) <= 0
    ) {
      throw new BadRequestException(
        "maxInfluencers is required and must be greater than 0",
      );
    }
    if (
      !Number.isFinite(Number(normalized.minInfluencers)) ||
      Number(normalized.minInfluencers) <= 0
    ) {
      normalized.minInfluencers = 1;
    }
    const inviteRecipientRole = this.normalizeInviteRecipientRole(
      data?.inviteRecipientRole,
      persistedOwnerType,
    );
    this.applyCampaignTargetCategoryLimit(normalized, inviteRecipientRole);
    if (ownerType === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    normalized.ownerType = persistedOwnerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      ownerType,
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
    const campaignNumber = await this.nextCampaignNumber();
    const campaign = new this.campaignModel({
      ...normalized,
      brandId: ownerId,
      campaignNumber,
    });

    // Relocate any staged-upload campaign image(s) into their final
    // campaigns/{_id}/images/ folder now that the document's _id is known,
    // before the single .save() below.
    const campaignId = String(campaign._id);
    const imagesFolder = CloudinaryFolders.campaign.images(campaignId);
    if (campaign.image?.public_id) {
      campaign.image = await this.cloudinaryService.relocateAsset(
        campaign.image,
        imagesFolder,
      );
    }
    if (campaign.resourceImages?.length) {
      campaign.resourceImages = await Promise.all(
        campaign.resourceImages.map(async (img: any) => ({
          ...img,
          ...(await this.cloudinaryService.relocateAsset(img, imagesFolder)),
        })),
      );
    }

    return await campaign.save();
  }

  private async nextCampaignNumber(): Promise<number> {
    const doc = await this.counterModel.findOneAndUpdate(
      { _id: "campaign" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    return doc.seq;
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

  private normalizeInfluencerFeedScope(
    scope?: string,
  ): InfluencerFeedScope | null {
    const normalized = String(scope || "")
      .trim()
      .toLowerCase();
    if (normalized === "campaign") return "campaign";
    if (normalized === "collaboration") return "collaboration";
    return null;
  }

  private isCollaborationCampaign(
    campaign: any,
    photographerOwnerIds?: Set<string>,
  ): boolean {
    const ownerType = String(
      campaign?.ownerType || campaign?.createdByRole || "",
    )
      .trim()
      .toLowerCase();
    const requestKind = String(campaign?.requestKind || "")
      .trim()
      .toLowerCase();
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

  async findPublic(
    status: string = "active",
    influencerId?: string,
    scope?: string,
  ) {
    const TIER_ORDER = [
      "Starter",
      "Nano",
      "Micro",
      "Mid-Tier",
      "Macro",
      "Mega / Celebrity",
    ];
    const allowedStatuses = new Set(["active", "completed"]);
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

    // Load influencer once for tier/location eligibility filtering.
    // Verification is enforced at apply-time (assertCampaignEligible), not here,
    // so unverified influencers can still browse campaigns.
    let influencer: any = null;
    if (influencerId) {
      influencer = await this.influencerModel
        .findById(influencerId)
        .select("socialMedia location isEmailVerified isMobileVerified")
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
        return sm.some(
          (entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === requiredIdx,
        );
      }
      const matching = sm.filter((entry: any) =>
        campaignPlatforms.some(
          (p) => normalized(p) === normalized(entry.platform),
        ),
      );
      if (matching.length === 0) return false;
      return matching.some(
        (entry: any) => TIER_ORDER.indexOf(entry.tier ?? "") === requiredIdx,
      );
    };

    const feedScope = influencerId
      ? this.normalizeInfluencerFeedScope(scope)
      : null;

    const campaignOwnerIds = [
      ...new Set(
        campaigns.map((c: any) => String(c?.brandId || "")).filter(Boolean),
      ),
    ];
    const photographerOwnerRows: any[] = campaignOwnerIds.length
      ? await this.photographerModel
          .find({ _id: { $in: campaignOwnerIds } })
          .select("_id")
          .lean()
      : [];
    const photographerOwnerIds = new Set(
      (photographerOwnerRows || [])
        .map((p: any) => String(p?._id || ""))
        .filter(Boolean),
    );

    // Filter: scope + tier/location eligibility for influencer discovery.
    const visible = campaigns.filter((c) => {
      if (
        feedScope === "campaign" &&
        this.isCollaborationCampaign(c, photographerOwnerIds)
      ) {
        return false;
      }
      if (
        feedScope === "collaboration" &&
        !this.isCollaborationCampaign(c, photographerOwnerIds)
      ) {
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

      // State check (case-insensitive)
      if (c.targetState) {
        const infState = (influencer.location?.state ?? "")
          .trim()
          .toLowerCase();
        const targetState = String(c.targetState || "")
          .trim()
          .toLowerCase();
        if (infState && infState !== targetState) return false;
      }

      // District check (case-insensitive)
      if (c.targetDistrict) {
        const infDistrict = (influencer.location?.district ?? "")
          .trim()
          .toLowerCase();
        const targetDistrict = String(c.targetDistrict || "")
          .trim()
          .toLowerCase();
        if (infDistrict && infDistrict !== targetDistrict) return false;
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

  /**
   * Fields that become immutable once a campaign is approved (active).
   * These form the "contract" between brand and creators — changing them
   * after someone has accepted would be a breach of trust.
   */
  private readonly LOCKED_ON_APPROVAL = [
    "title",
    "campaignType",
    "platforms",
    "socialMedia",
    "pricePerInfluencer",
    "budgetMin",
    "budgetMax",
    "image",
    "images",
  ] as const;

  /**
   * Additional fields locked once any influencer has accepted (confirmed).
   * These are part of the work agreement — altering them after acceptance
   * creates a dispute risk.
   */
  private readonly LOCKED_ON_ACCEPTANCE = [
    "description",
    "deliverables",
    "specialInstructions",
    "inviteBenefits",
    "payToJoinBenefits",
    "payToJoinInstructions",
    "productDescription",
    "timelineStart",
    "venueName",
    "venueAddress",
    "venueCity",
    "venueDistrict",
    "venueState",
    "venueGoogleMapUrl",
    "postingDeadlineMode",
  ] as const;

  private stripMongoIds(val: any): any {
    // Mongoose documents/subdocuments (e.g. campaign.socialMedia entries) expose internal
    // bookkeeping (`$__`, `$__parent`, `__parentArray`) as their own enumerable keys, which
    // circularly reference the parent document — recursing into those blows the call stack.
    // Normalize to a plain object/array first so only schema fields remain.
    if (val && typeof val === "object" && typeof val.toObject === "function") {
      val = val.toObject({ depopulate: true, versionKey: false });
    }
    if (Array.isArray(val)) return val.map((v) => this.stripMongoIds(v));
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k of Object.keys(val)) {
        if (k === "_id" || k === "__v") continue;
        out[k] = this.stripMongoIds(val[k]);
      }
      return out;
    }
    return val;
  }

  private async assertEditableFields(campaign: any, incoming: any): Promise<void> {
    const status = String(campaign.status || "");
    const isApproved = status === "active" || status === "completed";
    if (!isApproved) return; // draft / pending_review / needs_changes → all editable

    // Check fields locked on approval
    for (const field of this.LOCKED_ON_APPROVAL) {
      if (!(field in incoming)) continue;
      const oldVal = JSON.stringify(this.stripMongoIds(campaign[field] ?? null));
      const newVal = JSON.stringify(this.stripMongoIds(incoming[field] ?? null));
      if (oldVal !== newVal) {
        throw new BadRequestException(
          `"${field}" cannot be changed after the campaign is approved.`,
        );
      }
    }

    // Check acceptance-locked fields only when someone has actually accepted
    const acceptedCount = await this.campaignInviteModel.countDocuments({
      campaignId: campaign._id,
      status: { $in: ["accepted", "payment_confirmed", "working", "submitted", "completed", "approved"] },
    });
    if (acceptedCount === 0) return;

    for (const field of this.LOCKED_ON_ACCEPTANCE) {
      if (!(field in incoming)) continue;
      const oldVal = JSON.stringify(this.stripMongoIds(campaign[field] ?? null));
      const newVal = JSON.stringify(this.stripMongoIds(incoming[field] ?? null));
      if (oldVal !== newVal) {
        throw new BadRequestException(
          `"${field}" cannot be changed after an influencer has confirmed participation.`,
        );
      }
    }
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
      if (
        [
          "active",
          "pending",
          "pending_review",
          "needs_changes",
          "rejected",
        ].includes(String(data.status))
      ) {
        // Skip re-review resolution when brand resumes a paused campaign.
        // The original admin approval still stands; no second review needed.
        const isResumingFromPause =
          campaign.status === "pending" && String(data.status) === "active";
        if (!isResumingFromPause) {
          data.status = await this.resolveInitialCampaignStatus(data.status);
        }
      }
      const allowed = VALID_TRANSITIONS[campaign.status] || [];
      if (!allowed.includes(data.status)) {
        throw new BadRequestException(
          `Cannot transition from '${campaign.status}' to '${data.status}'`,
        );
      }
      // This update path is the brand/host's own campaign endpoint (ownership
      // is checked above), so any manual completion through here is by the host.
      if (data.status === "completed") {
        data.completedBy = "host";
        data.completedAt = new Date();
      }
    }

    // ── Status-based field-lock enforcement ────────────────────────────────
    await this.assertEditableFields(campaign, data);
    // ────────────────────────────────────────────────────────────────────────

    const caps = await this.plansService.getUserPlanCapabilities(brandId);
    const settings = await this.appSettingsModel.findOne({}).lean().exec();
    if (data?.campaignMode) {
      this.assertCampaignModeAvailability(data, caps.hasPremium, settings);
    }

    if (data?.campaignType && data.campaignType !== campaign.campaignType) {
      const campaignOwnerType: "brand" | "photographer" =
        String(campaign.ownerType || campaign.createdByRole || "brand") ===
        "photographer"
          ? "photographer"
          : "brand";
      const selectedType = String(data.campaignType);
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
    const normalized = this.normalizeCampaignPayload(data, settings);
    const inviteRecipientRole = this.normalizeInviteRecipientRole(
      data?.inviteRecipientRole ?? campaign.inviteRecipientRole,
      campaignOwnerType,
    );
    this.applyCampaignTargetCategoryLimit(normalized, inviteRecipientRole);
    if (campaignOwnerType === "photographer") {
      normalized.campaignMode = "invite_only";
    }
    normalized.ownerType = campaignOwnerType;
    normalized.inviteRecipientRole = inviteRecipientRole;
    normalized.requestKind = this.resolveRequestKind(
      campaignOwnerType,
      inviteRecipientRole,
      campaign?.requestKind,
    );
    // Validate the merged (existing + incoming) document so partial updates
    // don't bypass type-specific required-field rules.
    const mergedForValidation = {
      ...(campaign.toObject ? campaign.toObject() : campaign),
      ...normalized,
    };
    const finalStatus = String(
      mergedForValidation?.status || campaign.status || "",
    )
      .trim()
      .toLowerCase();
    if (
      ["active", "pending", "pending_review", "needs_changes"].includes(
        finalStatus,
      )
    ) {
      const ownerProfile = await this.loadOwnerVerificationProfile(
        brandId,
        campaignOwnerType,
      );
      this.assertOwnerCanPost(ownerProfile, campaignOwnerType);
      await this.assertOwnerPhotoSafetyClear(brandId, campaignOwnerType);
    }
    const mergedMax = Number(mergedForValidation?.maxInfluencers || 0);
    if (!Number.isFinite(mergedMax) || mergedMax <= 0) {
      throw new BadRequestException(
        "maxInfluencers is required and must be greater than 0",
      );
    }
    const mergedMin = Number(mergedForValidation?.minInfluencers || 0);
    if (!Number.isFinite(mergedMin) || mergedMin <= 0) {
      normalized.minInfluencers = 1;
      mergedForValidation.minInfluencers = 1;
    }
    // Re-derive logisticsType from the merged document to keep the
    // discriminator consistent across partial updates.
    normalized.logisticsType = this.deriveLogisticsType(mergedForValidation);
    this.assertRequiredFieldsForCampaign(mergedForValidation);
    const previousStatus = campaign.status;
    Object.assign(campaign, normalized);
    const saved = await campaign.save();

    if (previousStatus !== "active" && saved.status === "active") {
      if (saved.campaignMode === "tier_filtered_open") {
        this.notifyMatchingInfluencers(saved).catch(() => {});
      } else if (saved.campaignMode === "invite_only") {
        this.notifyInvitedUsers(saved).catch(() => {});
      }
    }

    if (previousStatus !== "completed" && saved.status === "completed") {
      // Ending a campaign is an absolute cutoff: anyone still accepted/working with no
      // submission gets closed out and marked refunded — no admin action needed. Safe
      // no-op when nothing is pending (e.g. the auto-complete cron, which only ever
      // reaches 'completed' once no blocking invites remain).
      this.campaignInvitesService
        .expireUnsubmittedInvitesForCampaign(
          String(saved._id),
          "Campaign ended by host before submission.",
        )
        .catch(() => {
          /* non-critical */
        });
    }

    return saved;
  }

  private async notifyMatchingInfluencers(campaign: any): Promise<void> {
    const TIER_ORDER = [
      "Starter",
      "Nano",
      "Micro",
      "Mid-Tier",
      "Macro",
      "Mega / Celebrity",
    ];

    const {
      targetState,
      targetDistrict,
      venueState,
      venueDistrict,
      targetTiers,
      minInfluencerTier,
      platforms,
      categories,
      inviteRecipientRole,
      title,
      brandId,
    } = campaign;

    const isPhotographer =
      String(inviteRecipientRole || "influencer") === "photographer";
    const campaignPlatforms: string[] = Array.isArray(platforms)
      ? platforms
      : [];
    const campaignCategories: string[] = Array.isArray(categories)
      ? categories
      : [];
    const allowedTiers: string[] = Array.isArray(targetTiers)
      ? targetTiers
      : [];

    // Photographer campaigns use shoot venue location; influencer campaigns use targetState/District
    const locationState: string = isPhotographer
      ? venueState || targetState || ""
      : targetState || "";
    const locationDistrict: string = isPhotographer
      ? venueDistrict || targetDistrict || ""
      : targetDistrict || "";

    // Skip only if there is truly nothing to filter on
    const hasAnyFilter =
      locationState ||
      locationDistrict ||
      allowedTiers.length ||
      minInfluencerTier ||
      campaignCategories.length ||
      campaignPlatforms.length;
    if (!hasAnyFilter) return;

    // ── 1. Build DB-level query ──────────────────────────────────────────────
    const blockedRows = await this.profileFlagModel
      .find({
        userType: isPhotographer ? "Photographer" : "Influencer",
        status: "Open",
        flagCode: { $in: PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("userId")
      .lean();
    const blockedIds = [
      ...new Set(
        (blockedRows || [])
          .map((row: any) => String(row.userId))
          .filter(Boolean),
      ),
    ];
    const baseQuery: Record<string, any> = {
      isDeleted: { $ne: true },
      isEmailVerified: true,
      isMobileVerified: true,
      email: { $exists: true, $ne: "" },
    };
    if (blockedIds.length) baseQuery._id = { $nin: blockedIds };

    // Location filters (both optional)
    if (locationState) baseQuery["location.state"] = locationState;
    if (locationDistrict) baseQuery["location.district"] = locationDistrict;

    if (isPhotographer) {
      // Photographer campaigns: match on skills (e.g. "Fashion Photography")
      if (campaignCategories.length) {
        baseQuery.skills = { $in: campaignCategories };
      }
    } else {
      // Influencer campaigns: match on content categories AND platform
      if (campaignCategories.length) {
        baseQuery.categories = { $in: campaignCategories };
      }
      if (campaignPlatforms.length) {
        baseQuery.socialMedia = {
          $elemMatch: { platform: { $in: campaignPlatforms } },
        };
      }
    }

    // ── 2. Query the right model ─────────────────────────────────────────────
    const recipientModel = isPhotographer
      ? this.photographerModel
      : this.influencerModel;
    const dashboardPath = isPhotographer
      ? "/photographer-dashboard"
      : "/influencer-dashboard/campaigns";

    const candidates: any[] = await recipientModel
      .find(baseQuery)
      .select("name email socialMedia isEmailVerified isMobileVerified")
      .limit(500)
      .lean();

    if (!candidates.length) return;

    // ── 3. In-memory tier filter ─────────────────────────────────────────────
    const minTierIdx = minInfluencerTier
      ? TIER_ORDER.indexOf(String(minInfluencerTier))
      : -1;
    const hasTierFilter = allowedTiers.length > 0 || minTierIdx >= 0;

    const matched = hasTierFilter
      ? candidates.filter((c) => {
          const sm: any[] = c.socialMedia || [];
          // For influencers: only check tiers on campaign-targeted platforms
          // For photographers: check any social account (they're not platform-specific)
          const relevant =
            !isPhotographer && campaignPlatforms.length
              ? sm.filter((s) => campaignPlatforms.includes(s.platform))
              : sm;

          return relevant.some((s) => {
            const tierIdx = TIER_ORDER.indexOf(s.tier);
            if (allowedTiers.length && !allowedTiers.includes(s.tier))
              return false;
            if (minTierIdx >= 0 && tierIdx < minTierIdx) return false;
            return true;
          });
        })
      : candidates;

    if (!matched.length) return;

    // ── 4. Resolve sender name and notify matched users ──────────────────────
    const brand = (await this.brandModel
      .findById(brandId)
      .select("brandName name")
      .lean()) as any;
    // Sender could also be a photographer (photographer-created open campaign)
    const ownerPhotographer = !brand
      ? ((await this.photographerModel
          .findById(brandId)
          .select("name")
          .lean()) as any)
      : null;
    const brandName =
      brand?.brandName || brand?.name || ownerPhotographer?.name || "A creator";
    const frontendBase = (
      process.env.FRONTEND_URL || "https://trendstarz.in"
    ).replace(/\/$/, "");
    const campaignUrl = `${frontendBase}${dashboardPath}`;
    // For photographers use venue location label; for influencers use target location label.
    const locationLabel = [locationDistrict, locationState]
      .filter(Boolean)
      .join(", ");

    const notificationPromises = matched.map((recipient: any) => {
      const userRole = isPhotographer ? "photographer" : "influencer";
      const body = `${brandName} posted "${title}"${locationLabel ? ` in ${locationLabel}` : ""}.`;
      const base = [
        this.notificationsService
          .createForUser({
            userId: String(recipient._id),
            userRole,
            title: "New open campaign",
            body,
            url: dashboardPath,
          })
          .catch(() => {}),
        this.pushService
          .sendToUser(String(recipient._id), {
            title: "New open campaign",
            body,
            url: dashboardPath,
          }, 'campaign')
          .catch(() => {}),
      ];

      if (ENABLE_CAMPAIGN_LIVE_EMAILS && recipient.email) {
        const tpl = openCampaignLiveTemplate({
          influencerName: recipient.name || "Creator",
          campaignTitle: title,
          brandName,
          location: locationLabel,
          campaignUrl,
        });
        base.push(
          sendAppEmail({ to: recipient.email, ...tpl }).catch(() => {}),
        );
      }
      return Promise.allSettled(base);
    });

    await Promise.allSettled(notificationPromises);
  }

  private async notifyInvitedUsers(campaign: any): Promise<void> {
    const { _id: campaignId, title, brandId, inviteRecipientRole } = campaign;

    // Get all active invites for this campaign
    const inviteQueries: any[] = [{ campaignId }];
    if (/^[a-fA-F0-9]{24}$/.test(String(campaignId))) {
      inviteQueries.push({ campaignId: new Types.ObjectId(campaignId) });
    }

    const invites = await this.campaignInviteModel
      .find({ $or: inviteQueries, status: { $in: ["pending", "invited"] } })
      .select("influencerId recipientRole")
      .lean();

    if (!invites.length) return;

    // Get brand name
    const brand = (await this.brandModel
      .findById(brandId)
      .select("brandName name")
      .lean()) as any;
    const brandName = brand?.brandName || brand?.name || "A brand";
    const frontendBase = (
      process.env.FRONTEND_URL || "https://trendstarz.in"
    ).replace(/\/$/, "");
    const dashboardPath =
      String(inviteRecipientRole || "influencer") === "photographer"
        ? "/photographer-dashboard"
        : "/influencer-dashboard/invites";
    const campaignUrl = `${frontendBase}${dashboardPath}`;

    // Load recipient profiles and notify verified invited users after campaign is live.
    const notificationPromises = invites.map(async (invite: any) => {
      try {
        const recipientModel =
          String(invite.recipientRole || "influencer") === "photographer"
            ? this.photographerModel
            : this.influencerModel;

        const recipient = (await recipientModel
          .findById(invite.influencerId)
          .select("name email isEmailVerified isMobileVerified")
          .lean()) as any;

        if (
          !recipient?._id ||
          recipient.isEmailVerified !== true ||
          recipient.isMobileVerified !== true
        ) {
          return;
        }
        const userRole =
          String(invite.recipientRole || "influencer") === "photographer"
            ? "photographer"
            : "influencer";
        const body = `${brandName} invited you to "${title}".`;

        await this.notificationsService
          .createForUser({
            userId: String(recipient._id),
            userRole,
            title: "New campaign invite",
            body,
            url: dashboardPath,
          })
          .catch(() => {});

        await this.pushService
          .sendToUser(String(recipient._id), {
            title: "New campaign invite",
            body,
            url: dashboardPath,
          }, 'campaign')
          .catch(() => {});

        if (!ENABLE_CAMPAIGN_LIVE_EMAILS || !recipient?.email) return;

        const tpl = inviteCampaignLiveTemplate({
          recipientName: recipient.name || "Creator",
          campaignTitle: title,
          brandName,
          campaignUrl,
        });

        return sendAppEmail({ to: recipient.email, ...tpl }).catch(() => {});
      } catch (err) {
        console.error("Failed to notify invited user:", err);
      }
    });

    await Promise.allSettled(notificationPromises);
  }

  async remove(id: string, brandId: string) {
    const campaign = await this.campaignModel.findById(id);
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== brandId) {
      throw new BadRequestException("Not your campaign");
    }
    const inviteQueries: any[] = [{ campaignId: id }];
    if (/^[a-fA-F0-9]{24}$/.test(id)) {
      inviteQueries.push({ campaignId: new Types.ObjectId(id) });
    }
    await this.campaignInviteModel.deleteMany({ $or: inviteQueries });
    const publicId = campaign.image?.public_id;
    if (publicId) {
      await this.cloudinaryService
        .deleteImage(publicId)
        .catch((err) =>
          console.error(
            "[CampaignsService] Failed to delete campaign image:",
            publicId,
            err,
          ),
        );
    }
    return this.campaignModel.findByIdAndDelete(id);
  }
}
