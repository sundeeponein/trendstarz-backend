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
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";
import { EarlyAccessAssignmentService } from "./early-access-assignment.service";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

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

  private toRegex(value?: string) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }

  private applyAdminUserStatusFilter(filter: Record<string, any>, status?: string) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (normalizedStatus === "deleted") {
      filter.$and = [
        {
          $or: [
            { isDeleted: { $in: [true, "true"] } },
            { status: "deleted" },
          ],
        },
      ];
      return;
    }

    filter.isDeleted = { $nin: [true, "true"] };
    filter.status = normalizedStatus
      ? normalizedStatus
      : { $ne: "deleted" };
  }

  private applyContactVerificationFilter(filter: Record<string, any>, verification?: string) {
    const normalized = String(verification || "").trim().toLowerCase();
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

  private getEarlyAccessConfig(userType: "influencer" | "brand" | "photographer") {
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
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/@.*$/, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 40) || "firebase-user";
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
      const email = String(firebaseUser.email || "").trim().toLowerCase();
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
    this.applyContactVerificationFilter(filter, verification);
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
    const latestPayments = await this.loadLatestPaymentsByUserIds(
      influencers.map((u: any) => String(u?._id || "")).filter(Boolean),
    );
    for (const u of influencers as any[]) {
      u.latestPayment = latestPayments.get(String(u?._id || "")) || null;
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
    this.applyContactVerificationFilter(filter, verification);
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
    const latestPayments = await this.loadLatestPaymentsByUserIds(
      brands.map((b: any) => String(b?._id || "")).filter(Boolean),
    );
    for (const b of brands as any[]) {
      if (!b.brandLogo) b.brandLogo = [];
      if (!b.products) b.products = [];
      if (b.promotionalPrice === undefined && (b as any).price !== undefined) {
        b.promotionalPrice = (b as any).price;
      }
      (b as any).latestPayment = latestPayments.get(String(b?._id || "")) || null;
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
    this.applyContactVerificationFilter(filter, verification);
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
    const latestPayments = await this.loadLatestPaymentsByUserIds(
      photographers.map((p: any) => String(p?._id || "")).filter(Boolean),
    );
    for (const p of photographers as any[]) {
      (p as any).latestPayment = latestPayments.get(String(p?._id || "")) || null;
    }

    return photographers;
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

    const userType = normalizedType as "influencer" | "brand" | "photographer";
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
    },
  ) {
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }

    if (typeof body?.verifiedByTrendStarz === "boolean") {
      brand.verifiedByTrendStarz = !!body.verifiedByTrendStarz;
    }

    if (Array.isArray(body?.adminTags)) {
      brand.adminTags = this.normalizeAdminTags(body.adminTags);
    }

    const saved = await brand.save();
    return { message: "Brand verification updated", user: saved };
  }

  @Patch("users/:type/:id/contact-verification")
  async updateContactVerification(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body()
    body: {
      isEmailVerified?: boolean;
      isMobileVerified?: boolean;
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
    if (!hasEmail && !hasMobile) {
      return { message: "No verification fields provided", type, id };
    }

    if (hasEmail) {
      user.isEmailVerified = !!body.isEmailVerified;
      user.emailVerifiedAt = body.isEmailVerified ? user.emailVerifiedAt || new Date() : null;
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
      user.mobileVerifiedAt = body.isMobileVerified ? user.mobileVerifiedAt || new Date() : null;
      user.mobileVerificationDate = body.isMobileVerified
        ? user.mobileVerificationDate || new Date()
        : null;
      user.mobileVerificationMethod = body.isMobileVerified ? "Manual" : "";
      user.mobileVerifiedBy = body.isMobileVerified ? "Admin" : "";
    }

    const saved = await user.save();
    return { message: "Contact verification updated", user: saved };
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
}
