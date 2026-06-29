import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Query,
  Req,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";
import { EarlyAccessAssignmentService } from "./early-access-assignment.service";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import {
  applySearchEligibilityFilter,
  applyApprovedEligibilityFilter,
} from "../utils/profile-eligibility.util";
import { PROFILE_PHOTO_SAFETY_FLAG_CODES } from "../profile-verification/profile-verification.service";

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminUserTableController {
  private readonly earlyAccessTag = "Early Access";
  private readonly earlyAccessDurationDays = 30;
  private readonly commissionTags = [
    "Early Access",
    "Partner",
    "Internal/Test",
  ];

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Payment") private readonly paymentModel: Model<Payment>,
    @InjectModel("ProfileFlag") private readonly flagModel: Model<any>,
    private readonly earlyAccessAssignmentService: EarlyAccessAssignmentService,
    private readonly firebaseAdminService: FirebaseAdminService,
  ) {}

  private getPaging(pageRaw?: string, limitRaw?: string) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(1000, Math.max(1, Number(limitRaw) || 100));
    return {
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  private async loadLatestPaymentsByUserIds(userIds: string[]) {
    if (!userIds.length) return new Map<string, any>();
    const payments = await this.paymentModel
      .aggregate([
        {
          $match: {
            userId: { $in: userIds },
            status: "approved",
          },
        },
        { $sort: { approvedAt: -1, updatedAt: -1, createdAt: -1 } },
        {
          $group: {
            _id: "$userId",
            latest: { $first: "$$ROOT" },
          },
        },
      ])
      .exec();

    const byUserId = new Map<string, any>();
    for (const row of payments || []) {
      const key = String(row?._id || "");
      if (key) byUserId.set(key, row?.latest || null);
    }
    return byUserId;
  }

  // Mirrors the "Social Profile & Creator Tier" checklist item in
  // profile-verification.service.ts — kept in sync so the table's quick
  // badge and the detailed verification panel never disagree for the same user.
  private static readonly SOCIAL_TIER_FLAG_CODES = [
    "SOCIAL_LINK_MISSING",
    "SOCIAL_LINK_BROKEN",
    "SOCIAL_LINK_PRIVATE",
    "SOCIAL_LINK_MISMATCH",
    "SOCIAL_LINK_DUPLICATE",
    "FOLLOWER_COUNT_MISMATCH",
    "TIER_MISMATCH",
  ];

  // Mirrors the "Profile Photo" checklist item's visibility-block flag set
  // (quality + safety codes) in profile-verification.service.ts.
  private static readonly PROFILE_PHOTO_ACTION_FLAG_CODES = [
    "PROFILE_PHOTO_QUALITY",
    "PROFILE_PHOTO_PENDING_REVIEW",
    "PROFILE_PHOTO_MISSING",
    "PROFILE_PHOTO_GROUP",
    "PROFILE_PHOTO_BLURRY",
    "PROFILE_PHOTO_LOGO",
    "PROFILE_PHOTO_LOW_QUALITY",
    "FACE_NOT_VISIBLE",
    "PROFILE_PHOTO_SCREENSHOT",
    "PROFILE_PHOTO_POLICY",
    "PROFILE_PHOTO_CELEBRITY",
    "PROFILE_PHOTO_CONTACT_INFO",
    "PROFILE_PHOTO_QR_CODE",
  ];

  private static readonly LOCATION_ACTION_FLAG_CODES = [
    "LOCATION_MISSING",
    "LOCATION_MISMATCH",
    "INTERNATIONAL_LOCATION",
  ];

  private static readonly GALLERY_ACTION_FLAG_CODES = [
    "PORTFOLIO_MISSING",
    "PORTFOLIO_SCREENSHOT",
    "PORTFOLIO_LOW_QUALITY",
    "PORTFOLIO_DUPLICATE",
    "PORTFOLIO_WATERMARK",
  ];

  private static readonly PAYMENT_ACTION_FLAG_CODES = [
    "PAYMENT_MISSING",
    "PAYMENT_PENDING",
    "PAYMENT_FAILED",
    "PAN_MISSING",
  ];

  /** Batched (one query for the whole list) so listing users doesn't fire a flag lookup per row. */
  private async loadUserIdsWithOpenFlags(
    userIds: string[],
    flagCodes: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.flagModel
      .find({
        userId: { $in: userIds },
        status: "Open",
        flagCode: { $in: flagCodes },
      })
      .select("userId")
      .lean();
    return new Set(
      (rows || []).map((r: any) => String(r?.userId || "")).filter(Boolean),
    );
  }

  private toRegex(value?: string) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }

  private applyAdminUserStatusFilter(
    filter: Record<string, any>,
    status?: string,
  ) {
    const normalizedStatus = String(status || "")
      .trim()
      .toLowerCase();
    if (normalizedStatus === "deleted") {
      filter.$and = [
        {
          $or: [{ isDeleted: { $in: [true, "true"] } }, { status: "deleted" }],
        },
      ];
      return;
    }

    filter.isDeleted = { $nin: [true, "true"] };
    filter.status = normalizedStatus ? normalizedStatus : { $ne: "deleted" };
  }

  /**
   * Same dropdown as before (email/mobile pending combos), merged with the
   * Verification Funnel's later stages (search_eligible/admin_approved/
   * featured_eligible/campaign_eligible) instead of adding a second, redundant
   * filter control — reuses the exact eligibility functions the funnel widget
   * and the real Search/Welcome/Campaign checks use, so "show me Search
   * Eligible users" here can never drift from what Search actually shows.
   */
  private async applyContactVerificationFilter(
    filter: Record<string, any>,
    verification: string | undefined,
    role: { userType: string; photoField: string; requireSocialTier: boolean },
  ): Promise<void> {
    const normalized = String(verification || "")
      .trim()
      .toLowerCase();
    if (!normalized) return;
    if (normalized === "email_pending") {
      filter.isEmailVerified = { $ne: true };
      return;
    }
    if (normalized === "mobile_pending") {
      filter.isMobileVerified = { $ne: true };
      return;
    }
    if (normalized === "email_or_mobile_pending") {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { isEmailVerified: { $ne: true } },
            { isMobileVerified: { $ne: true } },
          ],
        },
      ];
      return;
    }
    if (normalized === "both_pending") {
      filter.isEmailVerified = { $ne: true };
      filter.isMobileVerified = { $ne: true };
      return;
    }
    if (normalized === "both_verified") {
      filter.isEmailVerified = true;
      filter.isMobileVerified = true;
      return;
    }
    if (normalized === "admin_review_pending") {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { verificationStatus: "pending" },
            { adminReviewPending: true },
          ],
        },
      ];
      return;
    }

    if (normalized === "search_eligible") {
      filter.status = "accepted";
      applySearchEligibilityFilter(filter, {
        photoField: role.photoField,
        requireSocialTier: role.requireSocialTier,
      });
      const blocked = await this.blockedFromPublicIds(role.userType);
      if (blocked.length) filter._id = { $nin: this.toExcludedIdValues(blocked) };
      return;
    }
    if (normalized === "admin_approved") {
      filter.status = "accepted";
      filter.isEmailVerified = true;
      filter.isMobileVerified = true;
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        { $or: [{ verifiedByTrendStarz: true }, { verificationStatus: "approved" }] },
      ];
      return;
    }
    if (normalized === "admin_review_rejected") {
      filter.verificationStatus = "rejected";
      return;
    }
    if (normalized === "featured_eligible" || normalized === "campaign_eligible") {
      filter.status = "accepted";
      applyApprovedEligibilityFilter(filter, {
        photoField: role.photoField,
        requireSocialTier: role.requireSocialTier,
      });
      const [blockedFromPublic, photoSafetyBlocked] = await Promise.all([
        this.blockedFromPublicIds(role.userType),
        normalized === "campaign_eligible"
          ? this.photoSafetyBlockedIds(role.userType)
          : Promise.resolve([] as string[]),
      ]);
      const blocked = [...new Set([...blockedFromPublic, ...photoSafetyBlocked])];
      if (blocked.length) filter._id = { $nin: this.toExcludedIdValues(blocked) };
    }
  }

  private normalizeAdminTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return Array.from(
      new Set(
        tags.map((tag) => String(tag || "").trim()).filter((tag) => !!tag),
      ),
    );
  }

  private keepSingleCommissionTag(tags: string[]): string[] {
    const normalized = this.normalizeAdminTags(tags);
    const present = this.commissionTags.filter((tag) =>
      normalized.includes(tag),
    );
    if (present.length <= 1) {
      return normalized;
    }

    const keepTag = present.includes(this.earlyAccessTag)
      ? this.earlyAccessTag
      : present[0];
    return [
      ...normalized.filter((tag) => !this.commissionTags.includes(tag)),
      keepTag,
    ];
  }

  private getEarlyAccessConfig(
    userType: "influencer" | "brand" | "photographer",
  ) {
    if (userType === "influencer") {
      return {
        cap: 50,
        badge: "early_access_creator",
        note: "Auto-assigned Early Access Creator (0% for 30 days)",
      };
    }
    if (userType === "photographer") {
      return {
        cap: 50,
        badge: "early_access_creator",
        note: "Auto-assigned Early Access Creator (0% for 30 days)",
      };
    }
    return {
      cap: 20,
      badge: "early_access_brand",
      note: "Auto-assigned Launch Partner Brand (0% for 30 days)",
    };
  }

  private getDefaultCommissionOverride() {
    return {
      enabled: false,
      overrideType: "discount",
      value: 0,
      validFrom: null,
      validUntil: null,
      notes: "",
      source: "",
      assignedBy: "",
      autoGenerated: false,
      assignedAt: null,
    };
  }

  private slugifyUsername(value: string): string {
    return (
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/@.*$/, "")
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 40) || "firebase-user"
    );
  }

  private async buildUniqueUsername(
    model: Model<any>,
    field: string,
    baseValue: string,
  ): Promise<string> {
    const base = this.slugifyUsername(baseValue);
    let candidate = base;
    for (let i = 1; i <= 50; i += 1) {
      const exists = await model.findOne({ [field]: candidate }).lean();
      if (!exists) return candidate;
      candidate = `${base}-${i}`;
    }
    return `${base}-${crypto.randomBytes(3).toString("hex")}`;
  }

  private resolveFirebaseUserType(
    firebaseUser: any,
    fallback: "influencer" | "brand" | "photographer" = "influencer",
  ): "influencer" | "brand" | "photographer" {
    const claims = firebaseUser?.customClaims || {};
    const raw = String(
      claims.role ||
        claims.userType ||
        claims.type ||
        claims.trendstarzRole ||
        "",
    ).toLowerCase();
    if (raw === "brand") return "brand";
    if (raw === "photographer" || raw === "photo" || raw === "videographer") {
      return "photographer";
    }
    if (raw === "influencer" || raw === "creator") return "influencer";
    return fallback;
  }

  private async createImportedFirebaseUser(
    userType: "influencer" | "brand" | "photographer",
    firebaseUser: any,
    email: string,
  ) {
    const createdAt = firebaseUser.metadata?.creationTime
      ? new Date(firebaseUser.metadata.creationTime)
      : new Date();
    const displayName =
      String(firebaseUser.displayName || "").trim() ||
      email.split("@")[0] ||
      "Firebase User";
    const placeholderPassword = await bcrypt.hash(
      crypto.randomBytes(32).toString("hex"),
      10,
    );
    const phoneNumber =
      String(firebaseUser.phoneNumber || "").trim() ||
      `pending-mobile:${firebaseUser.uid.slice(0, 24)}`;
    const common = {
      email,
      firebaseUid: firebaseUser.uid,
      password: placeholderPassword,
      phoneNumber,
      isEmailVerified: !!firebaseUser.emailVerified,
      isMobileVerified: !!firebaseUser.phoneNumber,
      firstRegisteredAt: createdAt,
      status: "pending",
      contact: { whatsapp: false, email: true, call: false },
      signupAttribution: {
        source: "firebase_import",
        audience: userType,
        referrerPath: "firebase_auth_console",
        capturedAt: new Date(),
      },
    };

    if (userType === "brand") {
      const brandUsername = await this.buildUniqueUsername(
        this.brandModel,
        "brandUsername",
        email,
      );
      return new this.brandModel({
        ...common,
        brandName: displayName,
        contactPersonName: displayName,
        brandUsername,
        categories: [],
        languages: [],
        brandLogo: [],
        products: [],
        location: { state: "", district: "", googleMapLink: "" },
      }).save();
    }

    if (userType === "photographer") {
      const username = await this.buildUniqueUsername(
        this.photographerModel,
        "username",
        email,
      );
      return new this.photographerModel({
        ...common,
        name: displayName,
        username,
        skills: [],
        equipment: [],
        pricing: [],
        socialMedia: [],
        profileImages: [],
        location: { state: "", district: "" },
        collaborationAvailability: {
          enabled: false,
          availableFor: [],
          preference: "",
          openToTravel: false,
        },
      }).save();
    }

    const username = await this.buildUniqueUsername(
      this.influencerModel,
      "username",
      email,
    );
    return new this.influencerModel({
      ...common,
      name: displayName,
      username,
      categories: [],
      creatorTypes: [],
      languages: [],
      socialMedia: [],
      profileImages: [],
      collaborationAvailability: {
        enabled: false,
        collaborationTypes: [],
        preference: "",
        availableFor: [],
        openToTravel: false,
      },
      verificationStatus: "not_submitted",
      verifiedByTrendStarz: false,
      verificationAdminNotes:
        "Imported from Firebase Auth because no MongoDB profile existed.",
    }).save();
  }

  private buildEarlyAccessOverride(
    config: { note: string },
    assignedBy: string,
  ) {
    const now = new Date();
    const validUntil = new Date(now);
    validUntil.setDate(validUntil.getDate() + this.earlyAccessDurationDays);

    return {
      enabled: true,
      overrideType: "fixed",
      value: 0,
      validFrom: now,
      validUntil,
      notes: config.note,
      source: "early_access_program",
      assignedBy,
      autoGenerated: true,
      assignedAt: now,
    };
  }

  @Get("admin-users")
  async getAdminUsers() {
    const admins = await this.userModel
      .find({ role: { $in: ["admin", "subadmin"] } }, { _id: 1, name: 1, email: 1, role: 1 })
      .lean();
    return admins.map((a: any) => ({
      id: String(a._id),
      name: a.name || a.email || "Admin",
      role: a.role as string,
    }));
  }

  @Post("early-access/auto-assign")
  async autoAssignEarlyAccess(@Req() req: any) {
    const actorId = String(
      req?.user?.userId || req?.user?.id || "system_auto_refill",
    );
    return this.earlyAccessAssignmentService.autoAssignEarlyAccess(actorId);
  }

  @Get("early-access/auto-assign/preview")
  autoAssignEarlyAccessPreview() {
    return this.earlyAccessAssignmentService.getAutoAssignPreview();
  }

  @Post("early-access/normalize-existing-tags")
  normalizeExistingCommissionTags() {
    return this.earlyAccessAssignmentService.normalizeExistingCommissionTags();
  }

  @Post("firebase/import-missing-users")
  async importMissingFirebaseUsers(
    @Body() body?: { fallbackType?: "influencer" | "brand" | "photographer" },
  ) {
    if (!this.firebaseAdminService.isConfigured()) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        byType: { influencer: 0, brand: 0, photographer: 0 },
        message: "Firebase Admin is not configured.",
      };
    }

    const fallbackType =
      body?.fallbackType === "brand" || body?.fallbackType === "photographer"
        ? body.fallbackType
        : "influencer";
    const firebaseUsers = await this.firebaseAdminService.listEmailUsers();
    const imported: any[] = [];
    const byType = { influencer: 0, brand: 0, photographer: 0 };
    let skipped = 0;

    for (const firebaseUser of firebaseUsers) {
      const email = String(firebaseUser.email || "")
        .trim()
        .toLowerCase();
      if (!email) {
        skipped += 1;
        continue;
      }

      const emailRegex = new RegExp(
        `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      );
      const [adminUser, influencer, brand, photographer] = await Promise.all([
        this.userModel.findOne({ email: emailRegex }).lean(),
        this.influencerModel.findOne({ email: emailRegex }).lean(),
        this.brandModel.findOne({ email: emailRegex }).lean(),
        this.photographerModel.findOne({ email: emailRegex }).lean(),
      ]);

      if (adminUser || influencer || brand || photographer) {
        skipped += 1;
        continue;
      }

      const userType = this.resolveFirebaseUserType(firebaseUser, fallbackType);
      const doc = await this.createImportedFirebaseUser(
        userType,
        firebaseUser,
        email,
      );
      byType[userType] += 1;
      imported.push({
        id: String(doc._id),
        email,
        userType,
        username: doc.username || doc.brandUsername || "",
        firebaseUid: firebaseUser.uid,
      });
    }

    return {
      success: true,
      imported: imported.length,
      skipped,
      byType,
      users: imported,
    };
  }

  @Post("firebase/import-missing-influencers")
  importMissingFirebaseInfluencers() {
    return this.importMissingFirebaseUsers({ fallbackType: "influencer" });
  }

  private async getActiveEarlyAccessCount(
    userType: "influencer" | "brand" | "photographer",
    badge: string,
    excludeUserId?: string,
  ): Promise<number> {
    const model =
      userType === "influencer"
        ? this.influencerModel
        : userType === "brand"
          ? this.brandModel
          : this.photographerModel;
    const now = new Date();
    const filter: Record<string, any> = {
      status: "accepted",
      isDeleted: { $ne: true },
      commissionBadge: badge,
      "commissionOverride.enabled": true,
      "commissionOverride.source": "early_access_program",
      $or: [
        { "commissionOverride.validFrom": null },
        { "commissionOverride.validFrom": { $lte: now } },
      ],
      $and: [
        {
          $or: [
            { "commissionOverride.validUntil": null },
            { "commissionOverride.validUntil": { $gte: now } },
          ],
        },
      ],
    };

    if (excludeUserId) {
      filter._id = { $ne: excludeUserId };
    }

    return model.countDocuments(filter);
  }

  @Get("influencers")
  async getInfluencers(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("category") category?: string,
    @Query("verification") verification?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const paging = this.getPaging(page, limit);
    const filter: any = {};
    this.applyAdminUserStatusFilter(filter, status);
    await this.applyContactVerificationFilter(filter, verification, {
      userType: "Influencer",
      photoField: "profileImages",
      requireSocialTier: true,
    });
    const qRegex = this.toRegex(q);
    if (qRegex) {
      filter.$or = [
        { name: qRegex },
        { username: qRegex },
        { email: qRegex },
        { phoneNumber: qRegex },
      ];
    }
    const categoryRegex = this.toRegex(category);
    if (categoryRegex) {
      filter.categories = categoryRegex;
    }
    const influencers = await this.influencerModel
      .find(filter)
      .sort({ firstRegisteredAt: -1, createdAt: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean()
      .exec();
    const influencerIds = influencers.map((u: any) => String(u?._id || "")).filter(Boolean);
    const latestPayments = await this.loadLatestPaymentsByUserIds(influencerIds);
    const socialTierFlagged = await this.loadUserIdsWithOpenFlags(
      influencerIds,
      AdminUserTableController.SOCIAL_TIER_FLAG_CODES,
    );
    const photoFlagged = await this.loadUserIdsWithOpenFlags(
      influencerIds,
      AdminUserTableController.PROFILE_PHOTO_ACTION_FLAG_CODES,
    );
    const locationFlagged = await this.loadUserIdsWithOpenFlags(
      influencerIds,
      AdminUserTableController.LOCATION_ACTION_FLAG_CODES,
    );
    const galleryFlagged = await this.loadUserIdsWithOpenFlags(
      influencerIds,
      AdminUserTableController.GALLERY_ACTION_FLAG_CODES,
    );
    const paymentFlagged = await this.loadUserIdsWithOpenFlags(
      influencerIds,
      AdminUserTableController.PAYMENT_ACTION_FLAG_CODES,
    );
    const now = new Date();
    for (const u of influencers as any[]) {
      const id = String(u?._id || "");
      u.isPremium = !!u?.isPremium && (!u?.premiumEnd || new Date(u.premiumEnd) >= now);
      u.latestPayment = latestPayments.get(id) || null;
      u.socialTierActionRequired = socialTierFlagged.has(id);
      u.profilePhotoActionRequired = photoFlagged.has(id);
      u.locationActionRequired = locationFlagged.has(id);
      u.galleryActionRequired = galleryFlagged.has(id);
      u.paymentActionRequired = paymentFlagged.has(id);
    }
    return influencers;
  }

  @Get("brands")
  async getBrands(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("category") category?: string,
    @Query("verification") verification?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const paging = this.getPaging(page, limit);
    const filter: any = {};
    this.applyAdminUserStatusFilter(filter, status);
    await this.applyContactVerificationFilter(filter, verification, {
      userType: "Brand",
      photoField: "brandLogo",
      requireSocialTier: false,
    });
    const qRegex = this.toRegex(q);
    if (qRegex) {
      filter.$or = [
        { brandName: qRegex },
        { brandUsername: qRegex },
        { email: qRegex },
        { phoneNumber: qRegex },
      ];
    }
    const categoryRegex = this.toRegex(category);
    if (categoryRegex) {
      filter.categories = categoryRegex;
    }
    const brands = await this.brandModel
      .find(filter)
      .sort({ firstRegisteredAt: -1, createdAt: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean()
      .exec();
    const brandIds = brands.map((b: any) => String(b?._id || "")).filter(Boolean);
    const latestPayments = await this.loadLatestPaymentsByUserIds(brandIds);
    const socialTierFlagged = await this.loadUserIdsWithOpenFlags(
      brandIds,
      AdminUserTableController.SOCIAL_TIER_FLAG_CODES,
    );
    const photoFlagged = await this.loadUserIdsWithOpenFlags(
      brandIds,
      AdminUserTableController.PROFILE_PHOTO_ACTION_FLAG_CODES,
    );
    const locationFlagged = await this.loadUserIdsWithOpenFlags(
      brandIds,
      AdminUserTableController.LOCATION_ACTION_FLAG_CODES,
    );
    const galleryFlagged = await this.loadUserIdsWithOpenFlags(
      brandIds,
      AdminUserTableController.GALLERY_ACTION_FLAG_CODES,
    );
    const paymentFlagged = await this.loadUserIdsWithOpenFlags(
      brandIds,
      AdminUserTableController.PAYMENT_ACTION_FLAG_CODES,
    );
    const brandsNow = new Date();
    for (const b of brands as any[]) {
      if (!b.brandLogo) b.brandLogo = [];
      if (!b.products) b.products = [];
      if (b.promotionalPrice === undefined && b.price !== undefined) {
        b.promotionalPrice = b.price;
      }
      b.isPremium = !!b?.isPremium && (!b?.premiumEnd || new Date(b.premiumEnd) >= brandsNow);
      const id = String(b?._id || "");
      b.latestPayment = latestPayments.get(id) || null;
      b.socialTierActionRequired = socialTierFlagged.has(id);
      b.profilePhotoActionRequired = photoFlagged.has(id);
      b.locationActionRequired = locationFlagged.has(id);
      b.galleryActionRequired = galleryFlagged.has(id);
      b.paymentActionRequired = paymentFlagged.has(id);
    }
    return brands;
  }

  @Get("photographers")
  async getPhotographers(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("category") category?: string,
    @Query("verification") verification?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const paging = this.getPaging(page, limit);
    const filter: any = {};
    this.applyAdminUserStatusFilter(filter, status);
    await this.applyContactVerificationFilter(filter, verification, {
      userType: "Photographer",
      photoField: "profileImages",
      requireSocialTier: true,
    });
    const qRegex = this.toRegex(q);
    if (qRegex) {
      filter.$or = [
        { name: qRegex },
        { username: qRegex },
        { email: qRegex },
        { phoneNumber: qRegex },
      ];
    }
    const categoryRegex = this.toRegex(category);
    if (categoryRegex) filter.skills = categoryRegex;

    const photographers = await this.photographerModel
      .find(filter)
      .sort({ firstRegisteredAt: -1, createdAt: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean()
      .exec();
    const photographerIds = photographers.map((p: any) => String(p?._id || "")).filter(Boolean);
    const latestPayments = await this.loadLatestPaymentsByUserIds(photographerIds);
    const socialTierFlagged = await this.loadUserIdsWithOpenFlags(
      photographerIds,
      AdminUserTableController.SOCIAL_TIER_FLAG_CODES,
    );
    const photoFlagged = await this.loadUserIdsWithOpenFlags(
      photographerIds,
      AdminUserTableController.PROFILE_PHOTO_ACTION_FLAG_CODES,
    );
    const locationFlagged = await this.loadUserIdsWithOpenFlags(
      photographerIds,
      AdminUserTableController.LOCATION_ACTION_FLAG_CODES,
    );
    const galleryFlagged = await this.loadUserIdsWithOpenFlags(
      photographerIds,
      AdminUserTableController.GALLERY_ACTION_FLAG_CODES,
    );
    const paymentFlagged = await this.loadUserIdsWithOpenFlags(
      photographerIds,
      AdminUserTableController.PAYMENT_ACTION_FLAG_CODES,
    );
    const photographersNow = new Date();
    for (const p of photographers as any[]) {
      const id = String(p?._id || "");
      p.isPremium = !!p?.isPremium && (!p?.premiumEnd || new Date(p.premiumEnd) >= photographersNow);
      p.latestPayment = latestPayments.get(id) || null;
      p.socialTierActionRequired = socialTierFlagged.has(id);
      p.profilePhotoActionRequired = photoFlagged.has(id);
      p.locationActionRequired = locationFlagged.has(id);
      p.galleryActionRequired = galleryFlagged.has(id);
      p.paymentActionRequired = paymentFlagged.has(id);
    }

    return photographers;
  }

  /**
   * "Blocked from public visibility" — the same flag-code set
   * users.service.ts's publicProfileBlockedIds() uses, reconstructed here
   * from this controller's own already-defined constants (photo
   * quality+safety, social tier, location) instead of cross-importing a
   * private helper from a different service.
   */
  /** `_id` is ObjectId-typed but ProfileFlag.userId is stored as a string — $nin needs both forms to actually exclude anything. */
  private toExcludedIdValues(ids: string[]): any[] {
    return ids.flatMap((id) => {
      const value = String(id || "").trim();
      if (!value) return [];
      return Types.ObjectId.isValid(value)
        ? [value, new Types.ObjectId(value)]
        : [value];
    });
  }

  private async blockedFromPublicIds(userType: string): Promise<string[]> {
    return this.flagModel.distinct("userId", {
      userType,
      status: "Open",
      flagCode: {
        $in: [
          ...AdminUserTableController.PROFILE_PHOTO_ACTION_FLAG_CODES,
          ...AdminUserTableController.SOCIAL_TIER_FLAG_CODES,
          ...AdminUserTableController.LOCATION_ACTION_FLAG_CODES,
        ],
      },
    });
  }

  private async photoSafetyBlockedIds(userType: string): Promise<string[]> {
    return this.flagModel.distinct("userId", {
      userType,
      status: "Open",
      flagCode: { $in: Array.from(PROFILE_PHOTO_SAFETY_FLAG_CODES) },
    });
  }

  /**
   * Registration → Campaign-eligible funnel, per role and combined. Each
   * stage reuses the exact same filter-building functions the real
   * Search/Welcome/Campaign eligibility checks use (profile-eligibility.util.ts),
   * so this widget can never silently drift from what users actually
   * experience — it's a read of the same rules, not a parallel copy.
   */
  @Get("verification-funnel")
  async getVerificationFunnel() {
    const roles: Array<{
      key: "influencer" | "brand" | "photographer";
      userType: string;
      model: Model<any>;
      photoField: string;
      requireSocialTier: boolean;
    }> = [
      { key: "influencer", userType: "Influencer", model: this.influencerModel, photoField: "profileImages", requireSocialTier: true },
      { key: "brand", userType: "Brand", model: this.brandModel, photoField: "brandLogo", requireSocialTier: false },
      { key: "photographer", userType: "Photographer", model: this.photographerModel, photoField: "profileImages", requireSocialTier: true },
    ];

    const combined = {
      registered: 0,
      active: 0,
      emailVerified: 0,
      mobileVerified: 0,
      searchEligible: 0,
      adminApproved: 0,
      featuredEligible: 0,
      campaignEligible: 0,
    };
    const byRole: Record<string, typeof combined> = {};

    for (const role of roles) {
      const [blockedFromPublicRaw, photoSafetyBlockedRaw] = await Promise.all([
        this.blockedFromPublicIds(role.userType),
        this.photoSafetyBlockedIds(role.userType),
      ]);
      const blockedFromPublic = this.toExcludedIdValues(blockedFromPublicRaw);
      const campaignBlocked = this.toExcludedIdValues([
        ...new Set([...blockedFromPublicRaw, ...photoSafetyBlockedRaw]),
      ]);

      const searchFilter: any = { status: "accepted" };
      applySearchEligibilityFilter(searchFilter, {
        photoField: role.photoField,
        requireSocialTier: role.requireSocialTier,
      });
      const searchFilterVisible = {
        ...searchFilter,
        _id: { $nin: blockedFromPublic },
      };

      const approvedFilter: any = { status: "accepted" };
      applyApprovedEligibilityFilter(approvedFilter, {
        photoField: role.photoField,
        requireSocialTier: role.requireSocialTier,
      });

      const featuredFilter = { ...approvedFilter, _id: { $nin: blockedFromPublic } };
      const campaignFilter = { ...approvedFilter, _id: { $nin: campaignBlocked } };

      const [
        registered,
        active,
        emailVerified,
        mobileVerified,
        searchEligible,
        adminApproved,
        featuredEligible,
        campaignEligible,
      ] = await Promise.all([
        role.model.countDocuments({}),
        role.model.countDocuments({ status: "accepted" }),
        role.model.countDocuments({ status: "accepted", isEmailVerified: true }),
        role.model.countDocuments({ status: "accepted", isEmailVerified: true, isMobileVerified: true }),
        role.model.countDocuments(searchFilterVisible),
        role.model.countDocuments({
          status: "accepted",
          isEmailVerified: true,
          isMobileVerified: true,
          $or: [{ verifiedByTrendStarz: true }, { verificationStatus: "approved" }],
        }),
        role.model.countDocuments(featuredFilter),
        role.model.countDocuments(campaignFilter),
      ]);

      const stageCounts = {
        registered,
        active,
        emailVerified,
        mobileVerified,
        searchEligible,
        adminApproved,
        featuredEligible,
        campaignEligible,
      };
      byRole[role.key] = stageCounts;
      (Object.keys(combined) as Array<keyof typeof combined>).forEach((stage) => {
        combined[stage] += stageCounts[stage];
      });
    }

    return { combined, byRole };
  }

  @Patch("users/:type/:id/tags")
  async patchUserTags(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body() body: { adminTags?: string[] },
    @Req() req: any,
  ) {
    const normalizedType = String(type || "").toLowerCase();
    let adminTags = this.keepSingleCommissionTag(
      this.normalizeAdminTags(body?.adminTags),
    );
    if (
      normalizedType !== "influencer" &&
      normalizedType !== "brand" &&
      normalizedType !== "photographer"
    ) {
      return { message: "Unsupported user type", type, id };
    }

    const userType = normalizedType;
    const model =
      userType === "influencer"
        ? this.influencerModel
        : userType === "brand"
          ? this.brandModel
          : this.photographerModel;
    const currentUser: any = await model.findById(id).lean();
    if (!currentUser) {
      return { message: "User not found", type, id };
    }

    const isPendingStatus =
      String(currentUser?.status || "").toLowerCase() === "pending";
    const isEmailVerified = !!currentUser?.isEmailVerified;
    const isMobileVerified = !!currentUser?.isMobileVerified;
    const isBlockedForPendingUnverified =
      isPendingStatus && !isEmailVerified && !isMobileVerified;
    if (isBlockedForPendingUnverified && adminTags.length > 0) {
      return {
        message:
          "Cannot assign badges/tags while user is pending and both email/mobile are unverified.",
        blocked: true,
        warnings: [
          "User is pending with email/mobile unverified. Verify at least one contact method or approve user before assigning badges/tags.",
        ],
        user: currentUser,
      };
    }

    const actorId = String(req?.user?.userId || req?.user?.id || "admin");
    const earlyAccessConfig = this.getEarlyAccessConfig(userType);
    const hasEarlyAccessTag = adminTags.includes(this.earlyAccessTag);

    const updateSet: Record<string, any> = { adminTags };
    const warnings: string[] = [];

    if (hasEarlyAccessTag) {
      if (String(currentUser?.status || "") !== "accepted") {
        adminTags = adminTags.filter((tag) => tag !== this.earlyAccessTag);
        updateSet.adminTags = adminTags;
        warnings.push("Early Access applies only to approved users.");
      } else {
        const activeCount = await this.getActiveEarlyAccessCount(
          userType,
          earlyAccessConfig.badge,
          id,
        );
        if (activeCount >= earlyAccessConfig.cap) {
          adminTags = adminTags.filter((tag) => tag !== this.earlyAccessTag);
          updateSet.adminTags = adminTags;
          warnings.push(
            userType === "brand"
              ? "Early Access cap reached (20 approved brands)."
              : "Early Access cap reached (50 approved creators).",
          );
        } else {
          updateSet.commissionBadge = earlyAccessConfig.badge;
          updateSet.commissionOverride = this.buildEarlyAccessOverride(
            earlyAccessConfig,
            actorId,
          );
        }
      }
    }

    if (!hasEarlyAccessTag) {
      const existingOverride = currentUser?.commissionOverride || {};
      const isAutoEarlyAccess =
        existingOverride?.autoGenerated === true &&
        existingOverride?.source === "early_access_program";
      if (isAutoEarlyAccess) {
        updateSet.commissionBadge = null;
        updateSet.commissionOverride = this.getDefaultCommissionOverride();
      }
    }

    const user = await model
      .findByIdAndUpdate(id, { $set: updateSet }, { new: true })
      .exec();

    if (!user) {
      return { message: "User not found", type, id };
    }

    return {
      message: warnings.length
        ? "User tags updated with constraints"
        : "User tags updated",
      warnings,
      earlyAccess: hasEarlyAccessTag
        ? {
            enabled: !!user?.commissionOverride?.enabled,
            validUntil: user?.commissionOverride?.validUntil || null,
            cap: earlyAccessConfig.cap,
          }
        : null,
      user,
    };
  }

  @Patch("users/influencer/:id/verification")
  async updateInfluencerVerification(
    @Param("id") id: string,
    @Body()
    body: {
      action?: "pending" | "approve" | "reject" | "remove";
      notes?: string;
    },
    @Req() req: any,
  ) {
    const influencer = await this.influencerModel.findById(id);
    if (!influencer) {
      return { message: "Influencer not found", id };
    }

    const action = String(body?.action || "").toLowerCase();
    const notes = String(body?.notes || "").trim();
    const actorId = String(req?.user?.userId || req?.user?.id || "admin");
    const actorRole = String(req?.user?.role || "admin");

    let status = influencer.verificationStatus || "not_submitted";
    if (action === "approve") status = "approved";
    else if (action === "reject") status = "rejected";
    else if (action === "remove") status = "removed";
    else if (action === "pending") status = "pending";

    influencer.verificationStatus = status;
    influencer.verifiedByTrendStarz = status === "approved";
    if (status === "approved") influencer.approvedAt = new Date();
    influencer.verificationAdminNotes = notes;

    const log = Array.isArray(influencer.verificationAuditLog)
      ? influencer.verificationAuditLog
      : [];
    log.push({
      action:
        action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : action === "remove"
              ? "removed"
              : notes
                ? "notes_updated"
                : "status_changed",
      status,
      note: notes,
      actorId,
      actorRole,
      actedAt: new Date(),
    });
    influencer.verificationAuditLog = log.slice(-100);

    const saved = await influencer.save();
    return { message: "Verification updated", user: saved };
  }

  @Patch("users/brand/:id/verification")
  async updateBrandVerification(
    @Param("id") id: string,
    @Body()
    body: {
      verifiedByTrendStarz?: boolean;
      adminTags?: string[];
      action?: "pending" | "approve" | "reject" | "remove";
      notes?: string;
    },
    @Req() req: any,
  ) {
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }

    const action = String(body?.action || "").toLowerCase();
    const notes = String(body?.notes || "").trim();
    const actorId = String(req?.user?.userId || req?.user?.id || "admin");
    const actorRole = String(req?.user?.role || "admin");
    let status = brand.verificationStatus || "not_submitted";
    if (action === "approve") status = "approved";
    else if (action === "reject") status = "rejected";
    else if (action === "remove") status = "removed";
    else if (action === "pending") status = "pending";

    if (typeof body?.verifiedByTrendStarz === "boolean") {
      brand.verifiedByTrendStarz = !!body.verifiedByTrendStarz;
      if (body.verifiedByTrendStarz) brand.approvedAt = new Date();
    }
    if (action) {
      brand.verificationStatus = status;
      // profileTier is a profile-quality tier, recomputed
      // by getDashboard() — admin approval must never set it directly.
      if (action === "approve") {
        brand.verifiedByTrendStarz = true;
        brand.approvedAt = new Date();
      } else if (action === "reject" || action === "remove") {
        brand.verifiedByTrendStarz = false;
      }
    }
    if (body?.notes !== undefined) {
      brand.verificationAdminNotes = notes;
      brand.profileModerationNotes = notes;
    }

    if (Array.isArray(body?.adminTags)) {
      brand.adminTags = this.normalizeAdminTags(body.adminTags);
    }

    if (action || body?.notes !== undefined) {
      const log = Array.isArray(brand.verificationAuditLog)
        ? brand.verificationAuditLog
        : [];
      log.push({
        action:
          action === "approve"
            ? "approved"
            : action === "reject"
              ? "rejected"
              : action === "remove"
                ? "removed"
                : notes
                  ? "notes_updated"
                  : "status_changed",
        status:
          action ? status : "pending",
        note: notes,
        actorId,
        actorRole,
        actedAt: new Date(),
      });
      brand.verificationAuditLog = log.slice(-100);
    }

    const saved = await brand.save();
    return { message: "Brand verification updated", user: saved };
  }

  @Patch("users/photographer/:id/verification")
  async updatePhotographerVerification(
    @Param("id") id: string,
    @Body()
    body: {
      action?: "pending" | "approve" | "reject" | "remove";
      notes?: string;
      verifiedByTrendStarz?: boolean;
      adminTags?: string[];
    },
    @Req() req: any,
  ) {
    const photographer = await this.photographerModel.findById(id);
    if (!photographer) {
      return { message: "Photographer not found", id };
    }

    const action = String(body?.action || "").toLowerCase();
    const notes = String(body?.notes || "").trim();
    const actorId = String(req?.user?.userId || req?.user?.id || "admin");
    const actorRole = String(req?.user?.role || "admin");

    let status = photographer.verificationStatus || "not_submitted";
    if (action === "approve") status = "approved";
    else if (action === "reject") status = "rejected";
    else if (action === "remove") status = "removed";
    else if (action === "pending") status = "pending";

    if (action) {
      photographer.verificationStatus = status;
      photographer.verifiedByTrendStarz = status === "approved";
      if (status === "approved") photographer.approvedAt = new Date();
      // profileTier is a profile-quality tier, recomputed
      // by getDashboard() — admin approval must never set it directly.
    }
    if (typeof body?.verifiedByTrendStarz === "boolean") {
      photographer.verifiedByTrendStarz = !!body.verifiedByTrendStarz;
      if (body.verifiedByTrendStarz) photographer.approvedAt = new Date();
    }
    if (body?.notes !== undefined) {
      photographer.verificationAdminNotes = notes;
      photographer.profileModerationNotes = notes;
    }
    if (Array.isArray(body?.adminTags)) {
      photographer.adminTags = this.normalizeAdminTags(body.adminTags);
    }

    if (action || body?.notes !== undefined) {
      const log = Array.isArray(photographer.verificationAuditLog)
        ? photographer.verificationAuditLog
        : [];
      log.push({
        action:
          action === "approve"
            ? "approved"
            : action === "reject"
              ? "rejected"
              : action === "remove"
                ? "removed"
                : notes
                  ? "notes_updated"
                  : "status_changed",
        status,
        note: notes,
        actorId,
        actorRole,
        actedAt: new Date(),
      });
      photographer.verificationAuditLog = log.slice(-100);
    }

    const saved = await photographer.save();
    return { message: "Photographer verification updated", user: saved };
  }

  @Patch("users/:type/:id/social-media/:idx")
  async patchSocialMediaEntry(
    @Param("type") type: string,
    @Param("id") id: string,
    @Param("idx") idx: string,
    @Body() body: { handle?: string; tier?: string; changedBy?: string; changedByName?: string },
  ) {
    const normalizedType = String(type || "").toLowerCase();
    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "brand"
          ? this.brandModel
          : normalizedType === "photographer"
            ? this.photographerModel
            : null;
    if (!model) throw new BadRequestException("Unsupported user type");

    const user = await model.findById(id);
    if (!user) throw new NotFoundException("User not found");

    const index = parseInt(idx, 10);
    const sm = Array.isArray(user.socialMedia) ? user.socialMedia[index] : null;
    if (!sm) throw new BadRequestException("Social media entry not found");

    const logEntry = {
      platformIdx: index,
      platform: sm.platform || "",
      oldHandle: sm.handle || "",
      newHandle: body.handle !== undefined ? String(body.handle).trim() : sm.handle || "",
      oldTier: sm.tier || "",
      newTier: body.tier !== undefined ? String(body.tier).trim() : sm.tier || "",
      changedBy: body.changedBy || "",
      changedByName: body.changedByName || "",
      changedAt: new Date(),
    };

    if (body.handle !== undefined) sm.handle = String(body.handle).trim();
    if (body.tier !== undefined) sm.tier = String(body.tier).trim();

    if (!Array.isArray(user.socialMediaEditLog)) user.socialMediaEditLog = [];
    const existingIdx = user.socialMediaEditLog.findIndex((e: any) => e.platformIdx === index);
    if (existingIdx >= 0) {
      user.socialMediaEditLog[existingIdx] = logEntry;
    } else {
      user.socialMediaEditLog.push(logEntry);
    }

    if (!Array.isArray(user.adminSocialNotifications)) user.adminSocialNotifications = [];
    const notifEntry = {
      platformIdx: index,
      platform: logEntry.platform,
      oldHandle: logEntry.oldHandle,
      newHandle: logEntry.newHandle,
      oldTier: logEntry.oldTier,
      newTier: logEntry.newTier,
      changedByName: logEntry.changedByName,
      changedAt: logEntry.changedAt,
      seen: false,
    };
    const existingNotifIdx = user.adminSocialNotifications.findIndex((e: any) => e.platformIdx === index);
    if (existingNotifIdx >= 0) {
      user.adminSocialNotifications[existingNotifIdx] = notifEntry;
    } else {
      user.adminSocialNotifications.push(notifEntry);
    }

    const saved = await user.save();
    return { message: "Social media updated", user: saved };
  }

  @Patch("users/:type/:id/contact-verification")
  async updateContactVerification(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body()
    body: {
      isEmailVerified?: boolean;
      isMobileVerified?: boolean;
      profilePhotoVerified?: boolean;
      photoPolicy?: boolean;
      photoFlagCode?: string;
      creatorTierVerified?: boolean;
      locationVerified?: boolean;
      galleryImagesVerified?: boolean;
      galleryFlagCode?: string;
      paymentVerified?: boolean;
    },
  ) {
    const normalizedType = String(type || "").toLowerCase();
    if (
      normalizedType !== "influencer" &&
      normalizedType !== "brand" &&
      normalizedType !== "photographer"
    ) {
      return { message: "Unsupported user type", type, id };
    }

    const user =
      normalizedType === "influencer"
        ? await this.influencerModel.findById(id)
        : normalizedType === "brand"
          ? await this.brandModel.findById(id)
          : await this.photographerModel.findById(id);

    if (!user) {
      return { message: "User not found", type, id };
    }

    const hasEmail = typeof body?.isEmailVerified === "boolean";
    const hasMobile = typeof body?.isMobileVerified === "boolean";
    const hasProfilePhoto = typeof body?.profilePhotoVerified === "boolean";
    const hasPhotoPolicy = typeof body?.photoPolicy === "boolean";
    const hasCreatorTier = typeof body?.creatorTierVerified === "boolean";
    const hasLocation = typeof body?.locationVerified === "boolean";
    const hasGallery = typeof body?.galleryImagesVerified === "boolean";
    const hasPayment = typeof body?.paymentVerified === "boolean";
    let hasPayoutDetails = false;
    if (
      !hasEmail &&
      !hasMobile &&
      !hasProfilePhoto &&
      !hasPhotoPolicy &&
      !hasCreatorTier &&
      !hasLocation &&
      !hasGallery &&
      !hasPayment
    ) {
      return { message: "No verification fields provided", type, id };
    }

    if (hasEmail) {
      if (!body.isEmailVerified && user.isEmailVerified === true) {
        throw new BadRequestException(
          "This email is already verified and cannot be unverified.",
        );
      }
      user.isEmailVerified = !!body.isEmailVerified;
      user.emailVerifiedAt = body.isEmailVerified
        ? user.emailVerifiedAt || new Date()
        : null;
      if (this.firebaseAdminService.isConfigured()) {
        try {
          await this.firebaseAdminService.setEmailVerified(
            user.email,
            !!body.isEmailVerified,
          );
        } catch {
          // Admin approval should still persist in MongoDB even if Firebase sync
          // is temporarily unavailable. Login trusts MongoDB verification.
        }
      }
    }
    if (hasMobile) {
      user.isMobileVerified = !!body.isMobileVerified;
      user.mobileVerified = !!body.isMobileVerified;
      user.mobileVerifiedAt = body.isMobileVerified
        ? user.mobileVerifiedAt || new Date()
        : null;
      user.mobileVerificationDate = body.isMobileVerified
        ? user.mobileVerificationDate || new Date()
        : null;
      user.mobileVerificationMethod = body.isMobileVerified ? "Manual" : "";
      user.mobileVerifiedBy = body.isMobileVerified ? "Admin" : "";
    }
    if (hasLocation) {
      user.locationVerified = !!body.locationVerified;
      user.locationVerifiedAt = body.locationVerified
        ? user.locationVerifiedAt || new Date()
        : null;
    }
    if (hasPayment) {
      const payout = user?.payout || {};
      hasPayoutDetails = !!(
        String(payout?.upiId || "").trim() ||
        String(payout?.mobile || "").trim() ||
        String(payout?.accountHolderName || "").trim()
      );
      const paymentVerified = !!body.paymentVerified && hasPayoutDetails;
      user.paymentVerified = paymentVerified;
      user.paymentVerifiedAt = paymentVerified
        ? user.paymentVerifiedAt || new Date()
        : null;
    }
    // These three were previously only ever resolved/opened as ProfileFlag
    // records below — the boolean field on the user document itself was
    // never written, so the response (and any list re-fetch) kept handing
    // the frontend a stale value, overwriting whatever the admin just set.
    if (hasProfilePhoto) {
      user.profilePhotoVerified = !!body.profilePhotoVerified;
    }
    if (hasCreatorTier) {
      user.creatorTierVerified = !!body.creatorTierVerified;
    }
    if (hasGallery) {
      user.galleryImagesVerified = !!body.galleryImagesVerified;
    }

    // Unverifying any checklist sub-item demotes the overall approval —
    // a profile can't keep showing "Verified" publicly while admin has just
    // flagged one of its parts as needing fix. Re-verifying a sub-item does
    // NOT auto-restore "approved" — that still requires an explicit Approve
    // action, so admin always makes the final call on the overall status.
    const anyJustUnverified =
      (hasMobile && !user.isMobileVerified) ||
      (hasLocation && !user.locationVerified) ||
      (hasPayment && !user.paymentVerified) ||
      (hasProfilePhoto && !user.profilePhotoVerified) ||
      (hasCreatorTier && !user.creatorTierVerified) ||
      (hasGallery && !user.galleryImagesVerified);
    if (anyJustUnverified) {
      user.verificationStatus = "pending";
      user.verifiedByTrendStarz = false;
      user.adminReviewPending = true;
      // profileTier is a profile-quality tier, recomputed
      // by getDashboard() — admin approval must never set it directly.
    }

    const saved = await user.save();

    const userType =
      normalizedType === "brand"
        ? "Brand"
        : normalizedType === "photographer"
          ? "Photographer"
          : "Influencer";
    const resolveFlags = async (flagCodes: string[], note: string) => {
      await this.flagModel.updateMany(
        {
          userId: String(id),
          userType,
          status: "Open",
          flagCode: { $in: flagCodes },
        },
        {
          $set: {
            status: "Resolved",
            reviewedBy: "Admin",
            reviewedAt: new Date(),
            reviewNotes: note,
          },
          $push: {
            auditLog: {
              action: "resolved",
              actorRole: "admin",
              note,
              actedAt: new Date(),
            },
          },
        },
      );
    };
    const openFlag = async (
      flagCode: string,
      category: string,
      severity: "Low" | "Medium" | "High",
      message: string,
      note: string,
    ) => {
      await this.flagModel.updateOne(
        {
          userId: String(id),
          userType,
          flagCode,
          status: "Open",
        },
        {
          $setOnInsert: {
            createdAt: new Date(),
            auditLog: [
              {
                action: "created",
                actorRole: "admin",
                note,
                actedAt: new Date(),
              },
            ],
          },
          $set: {
            category,
            severity,
            message,
            createdBy: "ADMIN",
            reviewedBy: "Admin",
            reviewedAt: new Date(),
            reviewNotes: note,
          },
        },
        { upsert: true },
      );
    };

    if (hasProfilePhoto) {
      const profilePhotoFlagCodes = [
        "PROFILE_PHOTO_QUALITY",
        "PROFILE_PHOTO_POLICY",
        "PROFILE_PHOTO_PENDING_REVIEW",
        "PROFILE_PHOTO_MISSING",
        "PROFILE_PHOTO_SCREENSHOT",
        "PROFILE_PHOTO_CELEBRITY",
        "PROFILE_PHOTO_GROUP",
        "PROFILE_PHOTO_BLURRY",
        "PROFILE_PHOTO_LOGO",
        "PROFILE_PHOTO_LOW_QUALITY",
        "FACE_NOT_VISIBLE",
        "PROFILE_PHOTO_CONTACT_INFO",
        "PROFILE_PHOTO_QR_CODE",
      ];

      const PHOTO_QUALITY_CODES = new Set([
        "PROFILE_PHOTO_QUALITY", "PROFILE_PHOTO_BLURRY", "PROFILE_PHOTO_GROUP",
        "PROFILE_PHOTO_LOGO", "PROFILE_PHOTO_LOW_QUALITY", "FACE_NOT_VISIBLE",
        "PROFILE_PHOTO_SCREENSHOT",
      ]);
      const PHOTO_POLICY_CODES = new Set([
        "PROFILE_PHOTO_POLICY", "PROFILE_PHOTO_CELEBRITY",
        "PROFILE_PHOTO_CONTACT_INFO", "PROFILE_PHOTO_QR_CODE",
      ]);
      const PHOTO_FLAG_MESSAGES: Record<string, string> = {
        "PROFILE_PHOTO_QUALITY":      "Profile photo quality needs improvement. Please upload a clear, high-quality photo.",
        "PROFILE_PHOTO_BLURRY":       "Profile photo quality needs improvement. Please upload a clear, high-quality photo.",
        "PROFILE_PHOTO_LOW_QUALITY":  "Profile photo quality needs improvement. Please upload a clear, high-quality photo.",
        "FACE_NOT_VISIBLE":           "Your profile photo must clearly show your face and contain only one person.",
        "PROFILE_PHOTO_GROUP":        "Your profile photo must clearly show your face and contain only one person.",
        "PROFILE_PHOTO_SCREENSHOT":   "Screenshots are not allowed. Please upload an original photo.",
        "PROFILE_PHOTO_CELEBRITY":    "Please upload your own photo. Celebrity photos, logos, and third-party images are not allowed.",
        "PROFILE_PHOTO_LOGO":         "Please upload your own photo. Celebrity photos, logos, and third-party images are not allowed.",
        "PROFILE_PHOTO_POLICY":       "Your photo contains content that violates platform guidelines.",
        "PROFILE_PHOTO_CONTACT_INFO": "Your photo contains content that violates platform guidelines.",
        "PROFILE_PHOTO_QR_CODE":      "Your photo contains content that violates platform guidelines.",
      };
      const photoFlagCode = String(body.photoFlagCode || "");
      if (body.profilePhotoVerified) {
        await resolveFlags(
          profilePhotoFlagCodes,
          "Profile photo verified by admin.",
        );
      } else if (PHOTO_POLICY_CODES.has(photoFlagCode)) {
        // Close all other photo flags first, then open the specific one
        await resolveFlags(
          profilePhotoFlagCodes.filter((c) => c !== photoFlagCode),
          `Superseded by policy flag (${photoFlagCode}).`,
        );
        await openFlag(
          photoFlagCode,
          "Identity",
          "High",
          PHOTO_FLAG_MESSAGES[photoFlagCode] || PHOTO_FLAG_MESSAGES["PROFILE_PHOTO_POLICY"],
          `Photo policy violation (${photoFlagCode}) flagged by admin.`,
        );
      } else if (body.photoPolicy) {
        // Close all other photo flags first, then open generic policy
        await resolveFlags(
          profilePhotoFlagCodes.filter((c) => c !== "PROFILE_PHOTO_POLICY"),
          "Superseded by policy flag (PROFILE_PHOTO_POLICY).",
        );
        await openFlag(
          "PROFILE_PHOTO_POLICY",
          "Identity",
          "High",
          PHOTO_FLAG_MESSAGES["PROFILE_PHOTO_POLICY"],
          "Photo policy violation flagged by admin.",
        );
      } else {
        // Quality flag — close all other photo flags first, then open the specific one
        const qualityCode = PHOTO_QUALITY_CODES.has(photoFlagCode) ? photoFlagCode : "PROFILE_PHOTO_QUALITY";
        await resolveFlags(
          profilePhotoFlagCodes.filter((c) => c !== qualityCode),
          `Superseded by quality flag (${qualityCode}).`,
        );
        await openFlag(
          qualityCode,
          "Identity",
          "Medium",
          PHOTO_FLAG_MESSAGES[qualityCode] || PHOTO_FLAG_MESSAGES["PROFILE_PHOTO_QUALITY"],
          `Profile photo quality issue (${qualityCode}) flagged by admin.`,
        );
      }
    }
    if (!hasProfilePhoto && hasPhotoPolicy) {
      // Standalone policy toggle (when photo quality was already approved separately)
      const allPhotoFlagCodes = [
        "PROFILE_PHOTO_QUALITY", "PROFILE_PHOTO_POLICY", "PROFILE_PHOTO_PENDING_REVIEW",
        "PROFILE_PHOTO_MISSING", "PROFILE_PHOTO_SCREENSHOT", "PROFILE_PHOTO_CELEBRITY",
        "PROFILE_PHOTO_GROUP", "PROFILE_PHOTO_BLURRY", "PROFILE_PHOTO_LOGO",
        "PROFILE_PHOTO_LOW_QUALITY", "FACE_NOT_VISIBLE",
        "PROFILE_PHOTO_CONTACT_INFO", "PROFILE_PHOTO_QR_CODE",
      ];
      const safetyPolicyCodes = new Set([
        "PROFILE_PHOTO_POLICY", "PROFILE_PHOTO_CELEBRITY",
        "PROFILE_PHOTO_CONTACT_INFO", "PROFILE_PHOTO_QR_CODE",
      ]);
      const standalonePolicyMessages: Record<string, string> = {
        "PROFILE_PHOTO_POLICY":       "Your photo contains content that violates platform guidelines.",
        "PROFILE_PHOTO_CELEBRITY":    "Your photo contains content that violates platform guidelines.",
        "PROFILE_PHOTO_CONTACT_INFO": "Your photo contains content that violates platform guidelines.",
        "PROFILE_PHOTO_QR_CODE":      "Your photo contains content that violates platform guidelines.",
      };
      if (!body.photoPolicy) {
        await resolveFlags(
          Array.from(safetyPolicyCodes),
          "Photo policy flag cleared by admin.",
        );
      } else {
        const spCode = String(body.photoFlagCode || "");
        const policyCode = safetyPolicyCodes.has(spCode) ? spCode : "PROFILE_PHOTO_POLICY";
        await resolveFlags(
          allPhotoFlagCodes.filter((c: string) => c !== policyCode),
          `Superseded by policy flag (${policyCode}).`,
        );
        await openFlag(
          policyCode,
          "Identity",
          "High",
          standalonePolicyMessages[policyCode] || standalonePolicyMessages["PROFILE_PHOTO_POLICY"],
          `Photo policy violation (${policyCode}) flagged by admin.`,
        );
      }
    }
    if (hasCreatorTier) {
      const tierFlagCodes = [
        "TIER_MISMATCH",
        "FOLLOWER_COUNT_MISMATCH",
        "SOCIAL_LINK_MISSING",
        "SOCIAL_LINK_MISMATCH",
        "SOCIAL_LINK_BROKEN",
        "SOCIAL_LINK_PRIVATE",
        "SOCIAL_LINK_DUPLICATE",
      ];
      if (body.creatorTierVerified) {
        await resolveFlags(
          tierFlagCodes,
          "Creator tier/social profile verified by admin.",
        );
      } else {
        await openFlag(
          "TIER_MISMATCH",
          "Social Media",
          "High",
          "Social profile and creator tier need verification. Please update your social media username/handle and select the correct tier range for your followers.",
          "Social profile and creator tier marked unverified by admin.",
        );
      }
    }
    if (hasLocation) {
      const locationFlagCodes = [
        "LOCATION_MISSING",
        "LOCATION_MISMATCH",
        "INTERNATIONAL_LOCATION",
      ];
      if (body.locationVerified) {
        await resolveFlags(locationFlagCodes, "Location verified by admin.");
      } else {
        await openFlag(
          "LOCATION_MISMATCH",
          "Location",
          "Medium",
          "Location details could not be verified. Please update your city, district, and state.",
          "Location marked unverified by admin.",
        );
      }
    }
    if (hasGallery) {
      const galleryFlagCodes = [
        "PORTFOLIO_MISSING",
        "PORTFOLIO_SCREENSHOT",
        "PORTFOLIO_LOW_QUALITY",
        "PORTFOLIO_DUPLICATE",
        "PORTFOLIO_WATERMARK",
      ];
      const GALLERY_FLAG_MESSAGES: Record<string, string> = {
        "PORTFOLIO_MISSING":     "Portfolio / gallery images are missing. Please add at least 3 images.",
        "PORTFOLIO_SCREENSHOT":  "Your gallery contains screenshots. Please upload original photos or work samples.",
        "PORTFOLIO_LOW_QUALITY": "Gallery images do not match TrendStarz guidelines. Please replace screenshots, duplicate, watermarked, or low-quality images.",
        "PORTFOLIO_DUPLICATE":   "Your gallery contains duplicate images. Please upload varied original content.",
        "PORTFOLIO_WATERMARK":   "Your gallery images contain watermarks. Please upload clean, unbranded images.",
      };
      const galleryFlagCode = String(body.galleryFlagCode || "");
      if (body.galleryImagesVerified) {
        await resolveFlags(
          galleryFlagCodes,
          "Gallery images verified by admin.",
        );
      } else {
        const galleryCode = galleryFlagCodes.includes(galleryFlagCode) ? galleryFlagCode : "PORTFOLIO_LOW_QUALITY";
        // Close all other gallery flags first — only one active at a time
        await resolveFlags(
          galleryFlagCodes.filter((c) => c !== galleryCode),
          `Superseded by gallery flag (${galleryCode}).`,
        );
        await openFlag(
          galleryCode,
          "Portfolio",
          "Medium",
          GALLERY_FLAG_MESSAGES[galleryCode] || GALLERY_FLAG_MESSAGES["PORTFOLIO_LOW_QUALITY"],
          `Gallery images flagged (${galleryCode}) by admin.`,
        );
      }
    }
    if (hasPayment) {
      const paymentFlagCodes = [
        "PAYMENT_MISSING",
        "PAYMENT_PENDING",
        "PAYMENT_FAILED",
        "PAN_MISSING",
      ];
      if (body.paymentVerified && hasPayoutDetails) {
        await resolveFlags(
          paymentFlagCodes,
          "Payment/payout method verified by admin.",
        );
      } else {
        await openFlag(
          "PAYMENT_MISSING",
          "Payment",
          "High",
          "Payment or payout method is not verified. Please add or correct your payout/payment details.",
          "Payment/payout method marked unverified by admin.",
        );
      }
    }

    return { message: "Contact verification updated", user: saved };
  }

  @Patch("users/:type/:id/community-status")
  async updateCommunityStatus(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body() body: { communityJoined?: boolean },
  ) {
    const normalizedType = String(type || "").toLowerCase();
    if (
      normalizedType !== "influencer" &&
      normalizedType !== "brand" &&
      normalizedType !== "photographer"
    ) {
      throw new BadRequestException("Unsupported user type");
    }

    if (typeof body?.communityJoined !== "boolean") {
      throw new BadRequestException("communityJoined is required");
    }

    const model =
      normalizedType === "influencer"
        ? this.influencerModel
        : normalizedType === "brand"
          ? this.brandModel
          : this.photographerModel;

    const patch = body.communityJoined
      ? {
          communityJoined: true,
          communityJoinedAt: new Date(),
          communityJoinedDate: new Date(),
        }
      : {
          communityJoined: false,
          communityName: "",
          communityState: "",
          communityJoinedAt: null,
          communityJoinedDate: null,
        };

    const user = await model.findByIdAndUpdate(id, { $set: patch }, { new: true });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    return { message: "Community status updated", user };
  }

  // PATCH endpoint to directly update brandLogo and products for a brand
  @Patch("brands/:id/images")
  async patchBrandImages(
    @Param("id") id: string,
    @Body() body: { brandLogo?: any[]; products?: any[] },
  ) {
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }
    if (body.brandLogo) {
      brand.brandLogo = body.brandLogo;
    }
    if (body.products) {
      brand.products = body.products;
    }
    await brand.save();
    return { message: "Brand images updated", brand };
  }

  // PATCH endpoint to directly update profileImages for an influencer (e.g. admin recrop)
  @Patch("influencers/:id/images")
  async patchInfluencerImages(
    @Param("id") id: string,
    @Body() body: { profileImages?: any[] },
  ) {
    const influencer = await this.influencerModel.findById(id);
    if (!influencer) {
      return { message: "Influencer not found", id };
    }
    if (body.profileImages) {
      influencer.profileImages = body.profileImages;
    }
    await influencer.save();
    return { message: "Influencer images updated", influencer };
  }

  // PATCH endpoint to directly update profileImages for a photographer (e.g. admin recrop)
  @Patch("photographers/:id/images")
  async patchPhotographerImages(
    @Param("id") id: string,
    @Body() body: { profileImages?: any[] },
  ) {
    const photographer = await this.photographerModel.findById(id);
    if (!photographer) {
      return { message: "Photographer not found", id };
    }
    if (body.profileImages) {
      photographer.profileImages = body.profileImages;
    }
    await photographer.save();
    return { message: "Photographer images updated", photographer };
  }
}
