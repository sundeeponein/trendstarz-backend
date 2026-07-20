import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";
import { PlansService } from "../plans/plans.service";
import { normalizeCollaborationAvailability } from "../utils/collaboration-availability.util";
import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "../utils/profile-selection-limits.util";
import { normalizeSocialMediaList } from "../utils/social-handle.util";
import {
  applyDiscoverableProfileFilter,
  applySearchEligibilityFilter,
  applyApprovedEligibilityFilter,
  buildSearchRankingStages,
  fetchFeaturedProfilesByScore,
  normalizeLocationValue,
  ViewerLocationContext,
} from "../utils/profile-eligibility.util";
import { withCloudinaryHeroTransform } from "../utils/cloudinary-transform.util";

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

const SOCIAL_TIER_VISIBILITY_BLOCK_FLAG_CODES = [
  "SOCIAL_LINK_MISSING",
  "SOCIAL_LINK_BROKEN",
  "SOCIAL_LINK_PRIVATE",
  "SOCIAL_LINK_MISMATCH",
  "SOCIAL_LINK_DUPLICATE",
  "FOLLOWER_COUNT_MISMATCH",
  "TIER_MISMATCH",
];

const LOCATION_VISIBILITY_BLOCK_FLAG_CODES = [
  "LOCATION_MISSING",
  "LOCATION_MISMATCH",
  "INTERNATIONAL_LOCATION",
];

const GALLERY_VISIBILITY_BLOCK_FLAG_CODES = [
  "PORTFOLIO_MISSING",
  "PORTFOLIO_SCREENSHOT",
  "PORTFOLIO_LOW_QUALITY",
  "PORTFOLIO_DUPLICATE",
  "PORTFOLIO_WATERMARK",
];

const PUBLIC_PROFILE_VISIBILITY_BLOCK_FLAG_CODES = [
  ...PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES,
  ...SOCIAL_TIER_VISIBILITY_BLOCK_FLAG_CODES,
  ...LOCATION_VISIBILITY_BLOCK_FLAG_CODES,
];

const FEATURED_PHOTOGRAPHER_FIELDS =
  "name username profileImage profileImages location skills pricing equipment socialMedia portfolio isPremium verifiedByTrendStarz verificationStatus socialMediaRestricted";

@Injectable()
export class PhotographersService {
  // TTL cache keyed by viewer location bucket to avoid cross-region reuse.
  private heroShowcaseCache = new Map<
    string,
    { value: { url: string; alt: string } | null; expiresAt: number }
  >();
  private static readonly HERO_SHOWCASE_CACHE_TTL_MS = 10 * 60 * 1000;

  constructor(
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("CampaignInvite")
    private readonly campaignInviteModel: Model<any>,
    @InjectModel("ProfileFlag") private readonly profileFlagModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
    private readonly plansService: PlansService,
  ) {}

  private async canViewPhotographerContact(
    photographer: any,
    viewerId?: string | null,
  ): Promise<boolean> {
    if (!viewerId) return false;
    if (String(photographer?._id) === String(viewerId)) return true;

    const viewerObjectId = this.isObjectId(viewerId)
      ? new Types.ObjectId(String(viewerId))
      : null;

    const invite = await this.campaignInviteModel
      .findOne({
        unlocked: true,
        unlockType: "paid_collab_payment",
        $or: [
          {
            influencerId: { $in: [photographer._id, String(photographer._id)] },
            recipientRole: "photographer",
            brandId: viewerObjectId
              ? { $in: [viewerObjectId, String(viewerId)] }
              : String(viewerId),
          },
          {
            brandId: { $in: [photographer._id, String(photographer._id)] },
            influencerId: viewerObjectId
              ? { $in: [viewerObjectId, String(viewerId)] }
              : String(viewerId),
          },
        ],
      })
      .select("_id")
      .lean();

    return !!invite;
  }

  private isObjectId(value: any): boolean {
    return !!value && Types.ObjectId.isValid(String(value));
  }

  private normalizePhone(value: any): string {
    return String(value ?? "").replace(/\D/g, "");
  }

  private normalizeEmail(value: any): string {
    return String(value ?? "")
      .trim()
      .toLowerCase();
  }

  private getPrimaryImageKey(images: any): string {
    const first = Array.isArray(images) ? images[0] : images;
    return String(first?.public_id || first?.url || first || "").trim();
  }

  private hasPrimaryProfileImageChanged(before: any, after: any): boolean {
    const beforeKey = this.getPrimaryImageKey(before);
    const afterKey = this.getPrimaryImageKey(after);
    return !!afterKey && beforeKey !== afterKey;
  }

  private async hasOpenPublicProfileBlock(userId: any): Promise<boolean> {
    const row = await this.profileFlagModel
      .findOne({
        userId: String(userId),
        userType: "Photographer",
        status: "Open",
        flagCode: { $in: PUBLIC_PROFILE_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("_id")
      .lean();
    return !!row;
  }

  private async blockedPhotographerIds(): Promise<string[]> {
    const rows = await this.profileFlagModel
      .find({
        userType: "Photographer",
        status: "Open",
        flagCode: { $in: PUBLIC_PROFILE_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("userId")
      .lean();
    return [
      ...new Set(
        (rows || []).map((row: any) => String(row.userId)).filter(Boolean),
      ),
    ];
  }

  private selectStringToProjection(fields: string): Record<string, 1> {
    const projection: Record<string, 1> = { _id: 1 };
    for (const field of String(fields || "").split(/\s+/).filter(Boolean)) {
      projection[field] = 1;
    }
    return projection;
  }

  /** Eligible-only, weighted-score selection for the Welcome Page "Featured Photo/Videographers" section. */
  async getFeaturedPhotographers(
    limit = 6,
    viewerIsAuthenticated = false,
    viewerLocation?: ViewerLocationContext,
  ) {
    const filter: any = {};
    applyApprovedEligibilityFilter(filter, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated,
      requirePremium: true,
    });
    const blocked = await this.blockedPhotographerIds();
    if (blocked.length) {
      filter._id = {
        $nin: blocked.flatMap((id) => {
          const value = String(id || "").trim();
          if (!value) return [];
          return Types.ObjectId.isValid(value)
            ? [value, new Types.ObjectId(value)]
            : [value];
        }),
      };
    }
    return fetchFeaturedProfilesByScore(
      this.photographerModel,
      filter,
      FEATURED_PHOTOGRAPHER_FIELDS,
      limit,
      {
        from: "campaigninvites",
        matchField: "photographerId",
        statusIn: ["accepted", "payment_confirmed", "working", "submitted", "completed"],
        dateField: "updatedAt",
        windowDays: 30,
      },
      viewerLocation,
    );
  }

  /**
   * Homepage hero banner + hero slider image — one eligible, EXPLICITLY
   * opted-in (featuredInMarketing: true) photographer image. Same "Welcome"
   * eligibility bar as getFeaturedPhotographers, plus consent — being
   * premium/verified is not sufficient to show someone's photo publicly.
   */
  async getHeroShowcasePhotographerImage(
    viewerLocation?: ViewerLocationContext,
  ): Promise<{ url: string; alt: string } | null> {
    const cacheKey = [
      normalizeLocationValue(viewerLocation?.district),
      normalizeLocationValue(viewerLocation?.state),
      normalizeLocationValue(viewerLocation?.country),
    ].join("|");
    const cached = this.heroShowcaseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const filter: any = { featuredInMarketing: true };
    applyApprovedEligibilityFilter(filter, {
      photoField: "profileImages",
      requireSocialTier: true,
      requirePremium: true,
    });
    const blocked = await this.blockedPhotographerIds();
    if (blocked.length) {
      filter._id = {
        $nin: blocked.flatMap((id) => {
          const value = String(id || "").trim();
          if (!value) return [];
          return Types.ObjectId.isValid(value)
            ? [value, new Types.ObjectId(value)]
            : [value];
        }),
      };
    }
    const [photographer] = (await fetchFeaturedProfilesByScore(
      this.photographerModel,
      filter,
      "name profileImages",
      1,
      {
        from: "campaigninvites",
        matchField: "photographerId",
        statusIn: ["accepted", "payment_confirmed", "working", "submitted", "completed"],
        dateField: "updatedAt",
        windowDays: 30,
      },
      viewerLocation,
    )) as any[];
    const value = photographer?.profileImages?.[0]?.url
      ? {
          url: withCloudinaryHeroTransform(photographer.profileImages[0].url),
          alt: `${photographer.name || "Photographer"} on TrendStarz`,
        }
      : null;

    this.heroShowcaseCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PhotographersService.HERO_SHOWCASE_CACHE_TTL_MS,
    });
    return value;
  }

  private async hasOpenGalleryBlock(userId: any): Promise<boolean> {
    const row = await this.profileFlagModel
      .findOne({
        userId: String(userId),
        userType: "Photographer",
        status: "Open",
        flagCode: { $in: GALLERY_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("_id")
      .lean();
    return !!row;
  }

  /** Photographer Search eligibility — see applySearchEligibilityFilter for the shared rule. */
  private applyPublicDiscoveryEligibilityFilter(
    filter: any,
    viewerIsAuthenticated = false,
  ): void {
    applySearchEligibilityFilter(filter, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated,
    });
  }

  private visibleProfileImages(
    profileImages: any,
    hideGallery: boolean,
  ): any[] {
    const images = Array.isArray(profileImages) ? profileImages : [];
    return hideGallery ? images.slice(0, 1) : images;
  }

  private async clearProfilePhotoFlags(userId: string) {
    const now = new Date();
    const flagCodes = [
      "PROFILE_PHOTO_PENDING_REVIEW",
      "PROFILE_PHOTO_QUALITY",
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

    const hadOpenFlags = await this.profileFlagModel.countDocuments({
      userId: String(userId),
      userType: "Photographer",
      status: "Open",
      flagCode: { $in: flagCodes },
    });

    if (hadOpenFlags > 0) {
      await this.profileFlagModel.updateMany(
        {
          userId: String(userId),
          userType: "Photographer",
          status: "Open",
          flagCode: { $in: flagCodes },
        },
        {
          $set: {
            status: "Resolved",
            reviewedBy: "AUTO",
            reviewedAt: now,
            reviewNotes: "Auto-resolved: user re-uploaded profile photo.",
          },
          $push: {
            auditLog: {
              action: "auto_resolved",
              actorId: String(userId),
              actorRole: "user",
              note: "User re-uploaded profile photo after flag.",
              actedAt: now,
            },
          },
        },
      );
      // Re-upload after a flag auto-verifies — no pending queue needed.
      // Only an explicit admin "Unverify" can block again.
      await this.photographerModel.findByIdAndUpdate(userId, {
        $set: { profilePhotoVerified: true, adminReviewPending: false },
      });
    }
  }

  private async clearGalleryFlags(userId: string) {
    const now = new Date();
    await this.profileFlagModel.updateMany(
      {
        userId: String(userId),
        userType: "Photographer",
        status: "Open",
        flagCode: {
          $in: [
            "PORTFOLIO_MISSING",
            "PORTFOLIO_SCREENSHOT",
            "PORTFOLIO_LOW_QUALITY",
            "PORTFOLIO_DUPLICATE",
            "PORTFOLIO_WATERMARK",
          ],
        },
      },
      {
        $set: {
          status: "Resolved",
          reviewedBy: "AUTO",
          reviewedAt: now,
          reviewNotes:
            "Automatically cleared after user uploaded/replaced gallery images.",
        },
        $push: {
          auditLog: {
            action: "auto_resolved",
            actorId: String(userId),
            actorRole: "user",
            note: "User uploaded/replaced gallery images.",
            actedAt: now,
          },
        },
      },
    );
  }

  async getProfile(userId: string) {
    const rawDoc = await this.photographerModel.findById(userId).lean();
    if (!rawDoc || Array.isArray(rawDoc)) {
      throw new NotFoundException("Photographer not found");
    }
    let doc: any = rawDoc;
    if (!doc.lastLoginAt) {
      const now = new Date();
      const firstRegisteredAt = doc.firstRegisteredAt || doc.createdAt || now;
      await this.photographerModel.updateOne(
        { _id: doc._id },
        { $set: { lastLoginAt: now, firstRegisteredAt } },
      );
      doc = {
        ...doc,
        lastLoginAt: now,
        firstRegisteredAt,
      };
    }
    const {
      password: _pw,
      resetToken: _rt,
      resetTokenExpires: _rte,
      ...safe
    } = doc;
    return safe;
  }

  async updateProfile(userId: string, data: any, localAuthBypass = false) {
    const allowedFields = [
      "name",
      "username",
      "phoneNumber",
      "email",
      "gender",
      "dateOfBirth",
      "portfolio",
      "location",
      "skills",
      "pricing",
      "equipment",
      "socialMedia",
      "collaborationAvailability",
      "contact",
      "payout",
      "profileImage",
      "profileImagePublicId",
      "profileImages",
    ];
    const update: any = {};

    if (data?.location !== undefined) {
      const stateRaw = data?.location?.state ?? "";
      const districtRaw = data?.location?.district ?? "";
      const stateId = this.isObjectId(stateRaw) ? String(stateRaw) : null;
      const districtId = this.isObjectId(districtRaw)
        ? String(districtRaw)
        : null;

      const [stateDoc, districtDoc] = await Promise.all([
        stateId ? this.stateModel.findById(stateId).lean() : null,
        districtId ? this.districtModel.findById(districtId).lean() : null,
      ]);

      update.location = {
        state: stateDoc
          ? String((stateDoc as any)?.name || "")
          : String(stateRaw || ""),
        district: districtDoc
          ? String((districtDoc as any)?.name || "")
          : String(districtRaw || ""),
      };
    }

    for (const key of allowedFields) {
      if (key === "location") continue;
      if (key === "collaborationAvailability") {
        if (data[key] !== undefined) {
          update.collaborationAvailability = normalizeCollaborationAvailability(
            data[key],
            "photographer",
          );
        }
        continue;
      }
      if (key === "skills") {
        if (data[key] !== undefined) {
          update.skills = normalizeSelectionList(
            data[key],
            PROFILE_SELECTION_LIMITS.photographer.skills,
          );
        }
        continue;
      }
      if (key === "socialMedia") {
        if (data[key] !== undefined) {
          update.socialMedia = normalizeSocialMediaList(data[key]);
        }
        continue;
      }
      if (data[key] !== undefined) {
        update[key] = data[key];
      }
    }

    const current: any = await this.photographerModel
      .findById(userId)
      .select("phoneNumber email isMobileVerified isEmailVerified profileImages")
      .lean();
    if (!current) throw new NotFoundException("Photographer not found");

    // Cleanup old images if profileImages is being replaced — mirrors
    // updateInfluencerProfile()/updateBrandProfile() in users.service.ts.
    // Without this, a re-uploaded photo just orphans the previous one in
    // Cloudinary forever instead of replacing it.
    if (update.profileImages && Array.isArray(current.profileImages)) {
      for (const oldImg of current.profileImages) {
        const oldPublicId = oldImg?.public_id;
        if (
          oldPublicId &&
          !update.profileImages.some((img: any) => img?.public_id === oldPublicId)
        ) {
          try {
            await this.cloudinaryService.deleteImage(oldPublicId);
          } catch (err) {
            console.error(
              "[PATCH][ERROR] Failed to delete photographer image:",
              oldPublicId,
              err,
            );
          }
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, "phoneNumber")) {
      const existingPhone = this.normalizePhone(current.phoneNumber);
      const incomingPhone = this.normalizePhone(update.phoneNumber);
      // Verified numbers can be changed, but verification doesn't carry over —
      // the new number must be re-verified (manual call, or OTP if enabled).
      if (current.isMobileVerified && existingPhone !== incomingPhone) {
        update.previousVerifiedMobile = existingPhone;
        update.isMobileVerified = false;
        update.mobileVerified = false;
        update.mobileVerifiedAt = null;
        update.mobileVerificationDate = null;
        update.mobileVerificationMethod = "";
        update.mobileVerifiedBy = "";
      } else if (existingPhone !== incomingPhone) {
        update.isMobileVerified = false;
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, "email")) {
      const existingEmail = this.normalizeEmail(current.email);
      const incomingEmail = this.normalizeEmail(update.email);
      if (existingEmail !== incomingEmail) {
        if (current.isEmailVerified) {
          update.previousVerifiedEmail = existingEmail;
        }
        if (localAuthBypass) {
          // Local dev convenience: mirrors the registration/login bypass —
          // no real email provider locally, so trust the change immediately.
          update.isEmailVerified = true;
          update.emailVerifiedAt = new Date();
        } else {
          update.isEmailVerified = false;
        }
      }
    }

    const updated = await this.photographerModel
      .findByIdAndUpdate(userId, { $set: update }, { new: true })
      .lean();
    if (!updated) throw new NotFoundException("Photographer not found");
    if (
      Object.prototype.hasOwnProperty.call(update, "profileImages") &&
      this.hasPrimaryProfileImageChanged(
        current.profileImages,
        update.profileImages,
      )
    ) {
      await this.clearProfilePhotoFlags(userId);
    }
    if (
      Array.isArray(update.profileImages) &&
      update.profileImages.length > 1
    ) {
      await this.clearGalleryFlags(userId);
    }
    if (update.socialMedia) {
      await this.autoVerifyTierIfFixed(userId, update.socialMedia);
    }
    const {
      password: _pw,
      resetToken: _rt,
      resetTokenExpires: _rte,
      ...safe
    } = updated as any;
    return safe;
  }

  private async autoVerifyTierIfFixed(userId: string, socialMedia: any[]) {
    if (!Array.isArray(socialMedia) || socialMedia.length === 0) return;
    const hasValidEntry = socialMedia.some(
      (s: any) =>
        String(s?.handle || "").trim() &&
        (String(s?.tier || "").trim() || Number(s?.followersCount || 0) > 0),
    );
    if (!hasValidEntry) return;

    const tierFlagCodes = [
      "SOCIAL_LINK_MISSING",
      "SOCIAL_LINK_BROKEN",
      "SOCIAL_LINK_PRIVATE",
      "TIER_MISMATCH",
      "FOLLOWER_COUNT_MISMATCH",
    ];
    const openCount = await this.profileFlagModel.countDocuments({
      userId: String(userId),
      userType: "Photographer",
      status: "Open",
      flagCode: { $in: tierFlagCodes },
    });
    if (openCount === 0) return;

    const now = new Date();
    await this.profileFlagModel.updateMany(
      {
        userId: String(userId),
        userType: "Photographer",
        status: "Open",
        flagCode: { $in: tierFlagCodes },
      },
      {
        $set: {
          status: "Resolved",
          reviewedBy: "AUTO",
          reviewedAt: now,
          reviewNotes: "Auto-resolved: user updated social tier/handle.",
        },
        $push: {
          auditLog: {
            action: "auto_resolved",
            actorId: String(userId),
            actorRole: "user",
            note: "User selected a valid social tier after admin unverify.",
            actedAt: now,
          },
        },
      },
    );
    await this.photographerModel.findByIdAndUpdate(userId, {
      $set: { creatorTierVerified: true },
    });
  }

  async searchPhotographers(query: {
    skill?: string;
    location?: string;
    keyword?: string;
    limit?: number;
    page?: number;
    viewerState?: string;
    viewerDistrict?: string;
    viewerCountry?: string;
    smartLocationPriority?: boolean;
    viewerIsAuthenticated?: boolean;
  }) {
    const filter: any = { status: "accepted", isDeleted: { $ne: true } };
    applyDiscoverableProfileFilter(filter, {
      photoField: "profileImages",
      requireSocialTier: true,
      viewerIsAuthenticated: !!query.viewerIsAuthenticated,
    });
    if (query.skill) filter.skills = query.skill;
    if (query.location) filter["location.state"] = query.location;

    if (query.keyword) {
      const escaped = query.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [{ name: re }, { username: re }, { skills: re }, { "location.state": re }],
        },
      ];
    }

    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 60, 1), 100);
    const skip = (page - 1) * limit;

    const viewerContext: ViewerLocationContext = {
      state: String(query.viewerState || "").trim(),
      district: String(query.viewerDistrict || "").trim(),
      country: String(query.viewerCountry || process.env.DISCOVERY_DEFAULT_COUNTRY || "india").trim(),
      source: query.viewerIsAuthenticated ? "registered_profile" : "country_fallback",
    };

    const projection = this.selectStringToProjection(
      "name username email phoneNumber profileImage profileImages location skills pricing equipment socialMedia collaborationAvailability contact gender portfolio status adminTags isPremium commissionBadge commissionOverride verifiedByTrendStarz verificationStatus firstRegisteredAt createdAt lastLoginAt",
    );

    let docs = await this.photographerModel
      .aggregate([
        { $match: filter },
        ...buildSearchRankingStages(viewerContext, {
          invitesCollection: "campaigninvites",
          inviteMatchField: "influencerId",
          inviteStaticMatch: { recipientRole: "photographer" },
          reviewsCollection: "reviews",
          reviewTargetType: "photographer",
        }),
        { $skip: skip },
        { $limit: limit },
        { $project: projection },
      ])
      .exec();

    docs = docs.map((d: any) => ({
      ...d,
      profileImage: d?.profileImages?.[0]?.url || null,
    }));

    const hasManualLocationFilter = !!String(query.location || "").trim();
    const useSmartPriority =
      !!query.smartLocationPriority && !hasManualLocationFilter;
    const smartLocationMeta = {
      smartLocationPriorityApplied: useSmartPriority,
      manualLocationFilterApplied: hasManualLocationFilter,
      smartLocationContext: {
        viewerState: normalizeLocationValue(viewerContext.state) || null,
        viewerDistrict: normalizeLocationValue(viewerContext.district) || null,
        viewerCountry: normalizeLocationValue(viewerContext.country) || null,
        source: viewerContext.source || "none",
      },
    };

    return {
      data: docs,
      ...smartLocationMeta,
    };
  }

  private extractTopFollowersCount(user: any): number {
    const platforms = Array.isArray(user?.socialMedia) ? user.socialMedia : [];
    return platforms.reduce((max: number, sm: any) => {
      const followers = Number(sm?.followersCount || 0);
      return followers > max ? followers : max;
    }, 0);
  }

  async getPhotographerById(id: string, viewerId?: string | null) {
    if (!this.isObjectId(id)) {
      return null;
    }
    const rawDoc: any = await this.photographerModel
      .findOne({ _id: id, isDeleted: { $ne: true } })
      .select(
        "name username email phoneNumber profileImage profileImages location skills pricing equipment socialMedia collaborationAvailability contact gender portfolio status adminTags isPremium commissionBadge commissionOverride verifiedByTrendStarz verificationStatus isEmailVerified isMobileVerified",
      )
      .lean();
    if (!rawDoc || Array.isArray(rawDoc)) {
      return null;
    }
    const doc: any = rawDoc;
    if (await this.hasOpenPublicProfileBlock(doc._id)) return null;
    const hideGallery = await this.hasOpenGalleryBlock(doc._id);
    const allowContact = await this.canViewPhotographerContact(doc, viewerId);
    const allowSocial = await this.plansService.canViewSocialLinks(viewerId);
    const visibleProfileImages = this.visibleProfileImages(
      doc.profileImages,
      hideGallery,
    );
    return {
      ...doc,
      profileImages: visibleProfileImages,
      // Recompute from the live array — the stored singular field is legacy
      // and goes stale the moment profileImages[0] changes (re-upload/recrop).
      profileImage: visibleProfileImages[0]?.url || null,
      email: allowContact && doc?.isEmailVerified ? doc.email : undefined,
      phoneNumber:
        allowContact && doc?.isMobileVerified ? doc.phoneNumber : undefined,
      portfolio: allowContact ? doc.portfolio : undefined,
      contact: allowContact ? doc.contact : undefined,
      contactRestricted: !allowContact,
      socialMedia: allowSocial ? doc.socialMedia || [] : [],
      socialMediaRestricted: !allowSocial,
    };
  }

  async getPhotographerByUsername(username: string, viewerId?: string | null) {
    if (!username) return null;
    const rawDoc: any = await this.photographerModel
      .findOne({ username, isDeleted: { $ne: true } })
      .select(
        "name username email phoneNumber profileImage profileImages location skills pricing equipment socialMedia collaborationAvailability contact gender portfolio status adminTags isPremium commissionBadge commissionOverride verifiedByTrendStarz verificationStatus isEmailVerified isMobileVerified",
      )
      .lean();
    if (!rawDoc || Array.isArray(rawDoc)) {
      return null;
    }
    const doc: any = rawDoc;
    const allowContact = await this.canViewPhotographerContact(doc, viewerId);
    const allowSocial = await this.plansService.canViewSocialLinks(viewerId);
    return {
      ...doc,
      // Recompute from the live array — the stored singular field is legacy
      // and goes stale the moment profileImages[0] changes (re-upload/recrop).
      profileImage: doc?.profileImages?.[0]?.url || null,
      email: allowContact && doc?.isEmailVerified ? doc.email : undefined,
      phoneNumber:
        allowContact && doc?.isMobileVerified ? doc.phoneNumber : undefined,
      portfolio: allowContact ? doc.portfolio : undefined,
      contact: allowContact ? doc.contact : undefined,
      contactRestricted: !allowContact,
      socialMedia: allowSocial ? doc.socialMedia || [] : [],
      socialMediaRestricted: !allowSocial,
    };
  }
}
