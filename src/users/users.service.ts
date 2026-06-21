import { Injectable, BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { CloudinaryService } from "../cloudinary.service";
import { InfluencerProfileDto, BrandProfileDto } from "./dto/profile.dto";
import * as bcrypt from "bcryptjs";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";
import { normalizeCollaborationAvailability } from "../utils/collaboration-availability.util";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "../utils/profile-selection-limits.util";
import { normalizeSocialMediaList } from "../utils/social-handle.util";
import { consumeOtpVerificationToken } from "../otp/otp.controller";

const USE_LOCAL_IMAGES = process.env.USE_LOCAL_IMAGES === "true";
const LOCAL_IMAGE_DIR = path.resolve(__dirname, "../../assets/local-images");
if (USE_LOCAL_IMAGES && !fs.existsSync(LOCAL_IMAGE_DIR)) {
  fs.mkdirSync(LOCAL_IMAGE_DIR, { recursive: true });
}

// Minor quality issues: hide from public search only, campaigns still allowed
// All photo quality issues — hide from public search/discovery only
export const PROFILE_PHOTO_QUALITY_FLAG_CODES = [
  "PROFILE_PHOTO_QUALITY",
  "PROFILE_PHOTO_PENDING_REVIEW",
  "PROFILE_PHOTO_MISSING",
  "PROFILE_PHOTO_GROUP",
  "PROFILE_PHOTO_BLURRY",
  "PROFILE_PHOTO_LOGO",
  "PROFILE_PHOTO_LOW_QUALITY",
  "FACE_NOT_VISIBLE",
  "PROFILE_PHOTO_SCREENSHOT",
];

// Identity/trust safety violations — hide from search AND block campaign invites
export const PROFILE_PHOTO_SAFETY_FLAG_CODES = [
  "PROFILE_PHOTO_POLICY",
  "PROFILE_PHOTO_CELEBRITY",
  "PROFILE_PHOTO_CONTACT_INFO",
  "PROFILE_PHOTO_QR_CODE",
];

// Legacy alias kept for backward compat
export const PROFILE_PHOTO_POLICY_FLAG_CODES = PROFILE_PHOTO_SAFETY_FLAG_CODES;

// All photo flags block from public search/discovery (quality + safety)
const PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES = [
  ...PROFILE_PHOTO_QUALITY_FLAG_CODES,
  ...PROFILE_PHOTO_SAFETY_FLAG_CODES,
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

@Injectable()
export class UsersService {
  private normalizePhone(value: any): string {
    return String(value ?? "").replace(/\D/g, "");
  }

  private normalizeEmail(value: any): string {
    return String(value ?? "")
      .trim()
      .toLowerCase();
  }

  private slugify(text: string): string {
    return (text || "")
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
  }

  private async deleteFirebaseAuthUserForPermanentDelete(user: any): Promise<{
    firebaseDeleted: boolean;
    firebaseDeleteSkipped: boolean;
    firebaseDeleteError?: string;
  }> {
    if (!this.firebaseAdminService.isConfigured()) {
      return { firebaseDeleted: false, firebaseDeleteSkipped: true };
    }

    try {
      const firebaseUid = String(user?.firebaseUid || "").trim();
      if (firebaseUid) {
        const deleted =
          await this.firebaseAdminService.deleteUserByUid(firebaseUid);
        if (deleted)
          return { firebaseDeleted: true, firebaseDeleteSkipped: false };
      }

      const deletedByEmail = await this.firebaseAdminService.deleteUserByEmail(
        user?.email,
      );
      return { firebaseDeleted: deletedByEmail, firebaseDeleteSkipped: false };
    } catch (error: any) {
      console.error(
        "[DELETE] Error deleting Firebase Auth user during permanent delete:",
        error?.message || error,
      );
      return {
        firebaseDeleted: false,
        firebaseDeleteSkipped: false,
        firebaseDeleteError: error?.message || "Firebase user deletion failed.",
      };
    }
  }

  private async findBrandByNameOrSlug(brandName: string): Promise<any> {
    const normalized = (brandName || "").trim();
    if (!normalized) return null;

    // 1. Exact brandName match (case-insensitive, hyphens treated as spaces)
    const brand = await this.brandModel
      .findOne({
        brandName: new RegExp(
          `^${this.escapeRegex(normalized.replace(/-/g, " "))}$`,
          "i",
        ),
      })
      .lean();

    if (brand) return brand;

    // 2. Exact brandUsername match (handles slugs like "carols-cosmetics")
    const byUsername = await this.brandModel
      .findOne({
        brandUsername: new RegExp(`^${this.escapeRegex(normalized)}$`, "i"),
      })
      .lean();

    if (byUsername) return byUsername;

    // 3. Slug fallback: slugify the incoming string and match against brandName
    const decoded = this.slugify(normalized);
    const slugRegex = new RegExp(
      `^${decoded}$|^${decoded}-|\\b${decoded}\\b`,
      "i",
    );
    return this.brandModel.findOne({ brandName: slugRegex }).lean();
  }

  async trackInfluencerProfileImpression(username: string) {
    if (!username) return { tracked: false };
    const now = new Date();
    const updated = await this.influencerModel.updateOne(
      { username },
      {
        $inc: { "profileTraffic.impressions": 1 },
        $set: { "profileTraffic.lastImpressionAt": now },
      },
    );
    return { tracked: (updated.modifiedCount || 0) > 0 };
  }

  async trackInfluencerProfileClick(username: string) {
    if (!username) return { tracked: false };
    const now = new Date();
    const updated = await this.influencerModel.updateOne(
      { username },
      {
        $inc: { "profileTraffic.clicks": 1 },
        $set: { "profileTraffic.lastClickAt": now },
      },
    );
    return { tracked: (updated.modifiedCount || 0) > 0 };
  }

  async trackBrandProfileImpression(brandName: string) {
    const brand = await this.findBrandByNameOrSlug(brandName);
    if (!brand?._id) return { tracked: false };
    const now = new Date();
    const updated = await this.brandModel.updateOne(
      { _id: brand._id },
      {
        $inc: { "profileTraffic.impressions": 1 },
        $set: { "profileTraffic.lastImpressionAt": now },
      },
    );
    return { tracked: (updated.modifiedCount || 0) > 0 };
  }

  async trackBrandProfileClick(brandName: string) {
    const brand = await this.findBrandByNameOrSlug(brandName);
    if (!brand?._id) return { tracked: false };
    const now = new Date();
    const updated = await this.brandModel.updateOne(
      { _id: brand._id },
      {
        $inc: { "profileTraffic.clicks": 1 },
        $set: { "profileTraffic.lastClickAt": now },
      },
    );
    return { tracked: (updated.modifiedCount || 0) > 0 };
  }

  private extractMediaPublicIds(user: any): string[] {
    const publicIds = new Set<string>();

    const addPublicId = (value: unknown) => {
      if (typeof value === "string" && value.trim()) {
        publicIds.add(value);
      }
    };

    addPublicId(user?.profileImagePublicId);

    for (const img of user?.profileImages ?? []) {
      addPublicId(typeof img === "object" ? img?.public_id : img);
    }

    for (const img of user?.brandLogo ?? []) {
      addPublicId(typeof img === "object" ? img?.public_id : img);
    }

    for (const img of user?.products ?? []) {
      addPublicId(typeof img === "object" ? img?.public_id : img);
    }

    for (const img of user?.galleryImages ?? []) {
      addPublicId(typeof img === "object" ? img?.publicId : img);
    }

    return [...publicIds];
  }

  private async removeStoredMedia(publicIds: string[]): Promise<void> {
    for (const publicId of publicIds) {
      try {
        await this.cloudinaryService.deleteImage(publicId);
      } catch (err) {
        console.error("[MEDIA CLEANUP] Failed to delete image:", publicId, err);
      }
    }
  }

  private getImagePublicId(image: any): string {
    if (!image) return "";
    if (typeof image === "string") return image.trim();
    return String(image?.public_id || image?.publicId || "").trim();
  }

  private uniquePublicIds(values: string[]): string[] {
    return [
      ...new Set(
        values.map((value) => String(value || "").trim()).filter(Boolean),
      ),
    ];
  }

  private prepareSoftDeletedMediaSnapshot(
    user: any,
    userType: "Influencer" | "Brand" | "Photographer",
  ): string[] {
    const publicIdsToDelete: string[] = [];

    if (userType === "Brand") {
      const logos = Array.isArray(user?.brandLogo) ? user.brandLogo : [];
      const primaryLogo = logos[0] || null;
      publicIdsToDelete.push(
        ...logos.slice(1).map((img: any) => this.getImagePublicId(img)),
        ...(Array.isArray(user?.products)
          ? user.products.map((img: any) => this.getImagePublicId(img))
          : []),
        ...(Array.isArray(user?.galleryImages)
          ? user.galleryImages.map((img: any) => this.getImagePublicId(img))
          : []),
      );
      user.brandLogo = primaryLogo ? [primaryLogo] : [];
      user.products = [];
      user.galleryImages = [];
      return this.uniquePublicIds(publicIdsToDelete);
    }

    const images = Array.isArray(user?.profileImages) ? user.profileImages : [];
    const primaryImage = images[0] || null;
    publicIdsToDelete.push(
      ...images.slice(1).map((img: any) => this.getImagePublicId(img)),
      ...(Array.isArray(user?.galleryImages)
        ? user.galleryImages.map((img: any) => this.getImagePublicId(img))
        : []),
    );

    user.profileImages = primaryImage ? [primaryImage] : [];
    user.galleryImages = [];
    if (primaryImage && typeof primaryImage === "object") {
      user.profileImage =
        user.profileImage || primaryImage.url || primaryImage.secure_url || null;
      user.profileImagePublicId =
        user.profileImagePublicId ||
        primaryImage.public_id ||
        primaryImage.publicId ||
        null;
    }
    return this.uniquePublicIds(publicIdsToDelete);
  }

  private clearUserMediaFields(user: any) {
    user.profileImage = null;
    user.profileImagePublicId = null;
    user.profileImages = [];
    user.brandLogo = [];
    user.products = [];
    user.galleryImages = [];
  }

  async cleanupUserMediaById(id: string): Promise<{
    removedCount: number;
    userType: "Influencer" | "Brand" | "Photographer" | null;
    user: any;
  }> {
    let user: any = await this.influencerModel.findById(id);
    let userType: "Influencer" | "Brand" | "Photographer" | null = user
      ? "Influencer"
      : null;

    if (!user) {
      user = await this.brandModel.findById(id);
      userType = user ? "Brand" : null;
    }

    if (!user) {
      user = await this.photographerModel.findById(id);
      userType = user ? "Photographer" : null;
    }

    if (!user) {
      return { removedCount: 0, userType: null, user: null };
    }

    const publicIds = this.extractMediaPublicIds(user);
    await this.removeStoredMedia(publicIds);
    this.clearUserMediaFields(user);
    await user.save();

    return { removedCount: publicIds.length, userType, user };
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async checkUsername(username: string): Promise<{ exists: boolean }> {
    const normalized = (username || "").trim();
    if (!normalized) {
      return { exists: false };
    }

    const exactCaseInsensitive = new RegExp(
      `^${this.escapeRegex(normalized)}$`,
      "i",
    );
    const influencer = await this.influencerModel
      .findOne({ username: exactCaseInsensitive })
      .select("_id")
      .lean();

    return { exists: !!influencer };
  }

  async checkBrandNameUnique(name: string): Promise<boolean> {
    const normalized = (name || "").trim();
    if (!normalized) {
      return false;
    }

    const exactCaseInsensitive = new RegExp(
      `^${this.escapeRegex(normalized)}$`,
      "i",
    );
    const brand = await this.brandModel
      .findOne({ brandName: exactCaseInsensitive })
      .select("_id")
      .lean();

    return !!brand;
  }

  async checkRegistrationConflicts(query: {
    userType?: string;
    username?: string;
    brandUsername?: string;
    brandName?: string;
    email?: string;
    phoneNumber?: string;
  }): Promise<{
    username: boolean;
    brandUsername: boolean;
    brandName: boolean;
    email: boolean;
    phoneNumber: boolean;
    duplicateFields: string[];
  }> {
    const normalizedUserType = (query?.userType || "").trim().toUpperCase();
    const username = (query?.username || "").trim();
    const brandUsername = (query?.brandUsername || "").trim();
    const brandName = (query?.brandName || "").trim();
    const email = (query?.email || "").trim();
    const phoneNumber = (query?.phoneNumber || "").trim();

    const result = {
      username: false,
      brandUsername: false,
      brandName: false,
      email: false,
      phoneNumber: false,
      duplicateFields: [] as string[],
    };

    if (username && normalizedUserType !== "BRAND") {
      const usernameRegex = new RegExp(`^${this.escapeRegex(username)}$`, "i");
      const influencer = await this.influencerModel
        .findOne({ username: usernameRegex })
        .select("_id")
        .lean();
      result.username = !!influencer;
      if (result.username) result.duplicateFields.push("username");
    }

    if (brandUsername && normalizedUserType !== "INFLUENCER") {
      const brandUsernameRegex = new RegExp(
        `^${this.escapeRegex(brandUsername)}$`,
        "i",
      );
      const brand = await this.brandModel
        .findOne({
          $or: [
            { brandUsername: brandUsernameRegex },
            { brandName: brandUsernameRegex },
          ],
        })
        .select("_id")
        .lean();
      result.brandUsername = !!brand;
      if (result.brandUsername) result.duplicateFields.push("brandUsername");
    }

    if (brandName && normalizedUserType !== "INFLUENCER") {
      const brandNameRegex = new RegExp(
        `^${this.escapeRegex(brandName)}$`,
        "i",
      );
      const brandByName = await this.brandModel
        .findOne({ brandName: brandNameRegex })
        .select("_id")
        .lean();
      result.brandName = !!brandByName;
      if (result.brandName) result.duplicateFields.push("brandName");
    }

    if (email) {
      const emailRegex = new RegExp(`^${this.escapeRegex(email)}$`, "i");
      const [influencerByEmail, brandByEmail] = await Promise.all([
        this.influencerModel
          .findOne({ email: emailRegex })
          .select("_id")
          .lean(),
        this.brandModel.findOne({ email: emailRegex }).select("_id").lean(),
      ]);
      result.email = !!influencerByEmail || !!brandByEmail;
      if (result.email) result.duplicateFields.push("email");
    }

    if (phoneNumber) {
      const phoneRegex = new RegExp(`^${this.escapeRegex(phoneNumber)}$`, "i");
      const [influencerByPhone, brandByPhone] = await Promise.all([
        this.influencerModel
          .findOne({ phoneNumber: phoneRegex })
          .select("_id")
          .lean(),
        this.brandModel
          .findOne({ phoneNumber: phoneRegex })
          .select("_id")
          .lean(),
      ]);
      result.phoneNumber = !!influencerByPhone || !!brandByPhone;
      if (result.phoneNumber) result.duplicateFields.push("phoneNumber");
    }

    return result;
  }

  // Only use this for GDPR requests. Otherwise, always use soft delete.
  async deletePermanently(id: string) {
    // Try influencer first
    let user = await this.influencerModel.findById(id);
    if (user) {
      const errors: any[] = [];
      const firebaseDelete =
        await this.deleteFirebaseAuthUserForPermanentDelete(user);
      if (firebaseDelete.firebaseDeleteError) {
        throw new BadRequestException(firebaseDelete.firebaseDeleteError);
      }
      // Delete all images from Cloudinary
      if (user.profileImages && Array.isArray(user.profileImages)) {
        for (const img of user.profileImages) {
          const publicId =
            typeof img === "object"
              ? img.public_id
              : typeof img === "string"
                ? img
                : null;
          if (publicId) {
            try {
              await this.cloudinaryService.deleteImage(publicId);
            } catch (err) {
              console.error(
                "[DELETE] Error deleting influencer image from Cloudinary:",
                err,
                img,
              );
              errors.push({ type: "influencer", publicId, error: err });
            }
          }
        }
      }
      const deleteResult = await this.influencerModel.findByIdAndDelete(id);
      if (!deleteResult) {
        console.error(
          `[CLEANUP][ERROR] Influencer not found for deletion after Cloudinary cleanup: ${id}`,
        );
      } else {
      }
      // Double-check for any remaining influencer with this id
      const checkUser = await this.influencerModel.findById(id);
      if (checkUser) {
        console.error(
          `[CLEANUP][ERROR] Influencer still exists after deletion: ${id}`,
        );
      }
      if (errors.length > 0) {
        return {
          message: "Influencer deleted with some image deletion errors",
          user,
          errors,
          ...firebaseDelete,
        };
      }
      return {
        message: "Influencer permanently deleted",
        user,
        ...firebaseDelete,
      };
    }
    // Try brand
    user = await this.brandModel.findById(id);
    if (user) {
      const errors: any[] = [];
      const firebaseDelete =
        await this.deleteFirebaseAuthUserForPermanentDelete(user);
      if (firebaseDelete.firebaseDeleteError) {
        throw new BadRequestException(firebaseDelete.firebaseDeleteError);
      }
      if (user.brandLogo && Array.isArray(user.brandLogo)) {
        for (const img of user.brandLogo) {
          const publicId =
            typeof img === "object"
              ? img.public_id
              : typeof img === "string"
                ? img
                : null;
          if (publicId) {
            try {
              await this.cloudinaryService.deleteImage(publicId);
            } catch (cloudErr) {
              console.error(
                "[DELETE] Error deleting brand logo from Cloudinary:",
                cloudErr,
                img,
              );
              errors.push({ type: "brandLogo", publicId, error: cloudErr });
            }
          }
        }
      }
      if (user.products && Array.isArray(user.products)) {
        for (const img of user.products) {
          const publicId =
            typeof img === "object"
              ? img.public_id
              : typeof img === "string"
                ? img
                : null;
          if (publicId) {
            try {
              await this.cloudinaryService.deleteImage(publicId);
            } catch (cloudErr) {
              console.error(
                "[DELETE] Error deleting brand product image from Cloudinary:",
                cloudErr,
                img,
              );
              errors.push({ type: "brandProduct", publicId, error: cloudErr });
            }
          }
        }
      }
      const deleteResult = await this.brandModel.findByIdAndDelete(id);
      if (!deleteResult) {
        console.error(
          `[CLEANUP][ERROR] Brand not found for deletion after Cloudinary cleanup: ${id}`,
        );
      } else {
      }
      // Double-check for any remaining brand with this id
      const checkBrand = await this.brandModel.findById(id);
      if (checkBrand) {
        console.error(
          `[CLEANUP][ERROR] Brand still exists after deletion: ${id}`,
        );
      }
      if (errors.length > 0) {
        return {
          message: "Brand deleted with some image deletion errors",
          user,
          errors,
          ...firebaseDelete,
        };
      }
      return { message: "Brand permanently deleted", user, ...firebaseDelete };
    }

    // Try photographer
    user = await this.photographerModel.findById(id);
    if (user) {
      const errors: any[] = [];
      const firebaseDelete =
        await this.deleteFirebaseAuthUserForPermanentDelete(user);
      if (firebaseDelete.firebaseDeleteError) {
        throw new BadRequestException(firebaseDelete.firebaseDeleteError);
      }
      if (user.profileImages && Array.isArray(user.profileImages)) {
        for (const img of user.profileImages) {
          const publicId =
            typeof img === "object"
              ? img.public_id
              : typeof img === "string"
                ? img
                : null;
          if (publicId) {
            try {
              await this.cloudinaryService.deleteImage(publicId);
            } catch (cloudErr) {
              console.error(
                "[DELETE] Error deleting photographer image from Cloudinary:",
                cloudErr,
                img,
              );
              errors.push({ type: "photographer", publicId, error: cloudErr });
            }
          }
        }
      }

      const deleteResult = await this.photographerModel.findByIdAndDelete(id);
      if (!deleteResult) {
        console.error(
          `[CLEANUP][ERROR] Photographer not found for deletion after Cloudinary cleanup: ${id}`,
        );
      }

      const checkPhotographer = await this.photographerModel.findById(id);
      if (checkPhotographer) {
        console.error(
          `[CLEANUP][ERROR] Photographer still exists after deletion: ${id}`,
        );
      }

      if (errors.length > 0) {
        return {
          message: "Photographer deleted with some image deletion errors",
          user,
          errors,
          ...firebaseDelete,
        };
      }
      return {
        message: "Photographer permanently deleted",
        user,
        ...firebaseDelete,
      };
    }

    return { message: "User not found", id };
  }
  constructor(
    private readonly cloudinaryService: CloudinaryService,
    private readonly firebaseAdminService: FirebaseAdminService,
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("CampaignInvite")
    private readonly campaignInviteModel: Model<any>,
    @InjectModel("ProfileFlag") private readonly profileFlagModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

  private async publicProfileBlockedIds(
    userType: "Influencer" | "Brand" | "Photographer",
  ) {
    const rows = await this.profileFlagModel
      .find({
        userType,
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

  private async hasOpenPublicProfileBlock(
    userId: any,
    userType: "Influencer" | "Brand" | "Photographer",
  ): Promise<boolean> {
    const row = await this.profileFlagModel
      .findOne({
        userId: String(userId),
        userType,
        status: "Open",
        flagCode: { $in: PUBLIC_PROFILE_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("_id")
      .lean();
    return !!row;
  }

  private async hasOpenGalleryBlock(
    userId: any,
    userType: "Influencer" | "Brand" | "Photographer",
  ): Promise<boolean> {
    const row = await this.profileFlagModel
      .findOne({
        userId: String(userId),
        userType,
        status: "Open",
        flagCode: { $in: GALLERY_VISIBILITY_BLOCK_FLAG_CODES },
      })
      .select("_id")
      .lean();
    return !!row;
  }

  private applyPublicDiscoveryEligibilityFilter(filter: any): void {
    filter.isEmailVerified = true;
    filter.isMobileVerified = true;
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      { "profileImages.0": { $exists: true } },
      { "location.state": { $exists: true, $nin: ["", null] } },
      {
        socialMedia: {
          $elemMatch: {
            handle: { $exists: true, $nin: ["", null] },
            $or: [
              { tier: { $exists: true, $nin: ["", null] } },
              { followersCount: { $gt: 0 } },
            ],
          },
        },
      },
    ];
  }

  private visibleInfluencerProfileImages(
    profileImages: any,
    hideGallery: boolean,
  ): any[] {
    const images = Array.isArray(profileImages) ? profileImages : [];
    return hideGallery ? images.slice(0, 1) : images;
  }

  private applyExcludedIds(filter: any, ids: string[]) {
    if (!ids.length) return;
    filter._id = { ...(filter._id || {}), $nin: ids };
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

  private async clearProfilePhotoFlags(
    userId: string,
    userType: "Influencer" | "Photographer",
  ) {
    const now = new Date();
    await this.profileFlagModel.updateMany(
      {
        userId: String(userId),
        userType,
        status: "Open",
        flagCode: {
          $in: [
            "PROFILE_PHOTO_PENDING_REVIEW",
            "PROFILE_PHOTO_MISSING",
            "PROFILE_PHOTO_SCREENSHOT",
            "PROFILE_PHOTO_CELEBRITY",
            "PROFILE_PHOTO_GROUP",
            "PROFILE_PHOTO_BLURRY",
            "PROFILE_PHOTO_LOGO",
            "PROFILE_PHOTO_LOW_QUALITY",
            "FACE_NOT_VISIBLE",
          ],
        },
      },
      {
        $set: {
          status: "Resolved",
          reviewedBy: "AUTO",
          reviewedAt: now,
          reviewNotes:
            "Automatically cleared after user uploaded a profile photo with guidelines.",
        },
        $push: {
          auditLog: {
            action: "auto_resolved",
            actorId: String(userId),
            actorRole: "user",
            note: "User uploaded/replaced profile photo.",
            actedAt: now,
          },
        },
      },
    );
    const model =
      userType === "Photographer"
        ? this.photographerModel
        : this.influencerModel;
    await model.findByIdAndUpdate(userId, {
      $set: {
        adminReviewPending: false,
      },
    });
  }

  private async clearGalleryFlags(
    userId: string,
    userType: "Influencer" | "Brand" | "Photographer",
  ) {
    const now = new Date();
    await this.profileFlagModel.updateMany(
      {
        userId: String(userId),
        userType,
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

  /** True if the user has an active premium subscription right now. */
  private isCurrentlyPremium(user: any): boolean {
    if (!user?.isPremium) return false;
    if (!user.premiumEnd) return true;
    return new Date(user.premiumEnd) >= new Date();
  }

  /**
   * Decide whether `viewerId` is allowed to see the brand's social media handles.
   * Rule: opening social links is controlled by viewer plan capabilities.
   */
  async canViewBrandSocialMedia(
    brand: any,
    viewerId?: string | null,
  ): Promise<boolean> {
    if (!brand) return false;
    if (!viewerId) return false;
    if (String(brand._id) === String(viewerId)) return true;
    return this.canViewerOpenSocialLinks(viewerId);
  }

  private async canViewerOpenSocialLinks(
    viewerId?: string | null,
  ): Promise<boolean> {
    if (!viewerId) return false;
    const caps = await this.plansService.getUserPlanCapabilities(
      String(viewerId),
    );
    const hasSocialFeature = (caps?.features || []).some((f: any) => {
      const key = String(f?.key || "");
      const enabled = !!f?.value;
      return (
        enabled &&
        (key === "socialMediaVisibility" || key === "viewSocialLinks")
      );
    });
    return hasSocialFeature;
  }

  /** Throw if the user has already reached their maxImages plan limit */
  async checkImageUploadLimit(userId: string, currentCount: number) {
    const limit = await this.plansService.getLimit(userId, "maxProductImages");
    if (currentCount >= limit) {
      throw new BadRequestException(
        `Image upload limit reached. Your plan allows ${limit} image(s). Upgrade to upload more.`,
      );
    }
  }

  /**
   * Apply plan-based visibility filters to a public profile.
   * Hides socialMedia and contact when plan features are disabled.
   */
  applyPlanFilter(profile: any, caps: any) {
    const featureVal = (key: string) => {
      const f = (caps?.features ?? []).find((x: any) => x.key === key);
      return f ? f.value : false;
    };
    const result = { ...profile };
    if (!featureVal("socialMediaVisibility")) {
      result.socialMedia = [];
    }
    if (!featureVal("contactVisibility")) {
      result.contact = null;
      result.phoneNumber = undefined;
    }
    return result;
  }

  async getBrandByName(brandName: string, viewerId?: string | null) {
    const user: any = await this.findBrandByNameOrSlug(brandName);
    if (!user) return null;
    if (await this.hasOpenPublicProfileBlock(user._id, "Brand")) return null;
    const allowAccess = await this.canViewBrandSocialMedia(user, viewerId);
    const isPremium = this.isCurrentlyPremium(user);
    const hideGallery = await this.hasOpenGalleryBlock(user._id, "Brand");
    const {
      _id,
      brandName: name,
      foundedYear,
      companySize,
      email,
      phoneNumber,
      categories,
      location,
      socialMedia,
      brandLogo,
      products,
      website,
      googleMapAddress,
      promotionalPrice,
      languages,
      contact,
      profileTraffic,
    } = user;
    return {
      _id,
      name,
      email: allowAccess && user?.isEmailVerified ? email : undefined,
      phoneNumber:
        allowAccess && user?.isMobileVerified ? phoneNumber : undefined,
      categories,
      location: location || { state: "" },
      socialMedia: allowAccess ? socialMedia : [],
      socialMediaRestricted: !allowAccess,
      isPremium,
      brandLogo,
      products: hideGallery ? [] : products,
      foundedYear,
      companySize,
      website: allowAccess ? website : undefined,
      googleMapAddress,
      promotionalPrice,
      languages,
      contact: allowAccess ? contact : undefined,
      contactRestricted: !allowAccess,
      profileTraffic: profileTraffic || {
        impressions: 0,
        clicks: 0,
        lastImpressionAt: null,
        lastClickAt: null,
      },
    };
  }

  /**
   * Decide whether `viewerId` may view influencer contact details.
   * SINGLE RULE: contact is visible only when the brand has UNLOCKED the invite
   * (premium / paid_collab payment / 1 free unlock).
   */
  private async canViewInfluencerContact(
    influencer: any,
    viewerId?: string | null,
  ): Promise<boolean> {
    if (!viewerId) return false;
    if (String(influencer?._id) === String(viewerId)) return true;

    const brand: any = await this.brandModel
      .findById(viewerId)
      .select("_id brandUsername")
      .lean();
    if (!brand) return false;

    const invite = await this.campaignInviteModel
      .findOne({
        influencerId: influencer._id,
        unlocked: true,
        unlockType: "paid_collab_payment",
        $or: [
          { brandId: brand._id },
          { brandId: String(brand._id) },
          { brandId: brand.brandUsername },
        ],
      })
      .select("_id")
      .lean();

    return !!invite;
  }

  private async canViewInfluencerGender(
    influencer: any,
    viewerId?: string | null,
  ): Promise<boolean> {
    if (!viewerId) return false;
    if (String(influencer?._id) === String(viewerId)) return true;

    const admin: any = await this.userModel
      .findById(viewerId)
      .select("_id role")
      .lean();
    if (admin?.role === "admin" || admin?.role === "ADMIN") return true;

    const inf: any = await this.influencerModel
      .findById(viewerId)
      .select("_id isEmailVerified isMobileVerified")
      .lean();
    if (inf && (inf.isEmailVerified || inf.isMobileVerified)) return true;

    const brand: any = await this.brandModel
      .findById(viewerId)
      .select("_id isEmailVerified isMobileVerified")
      .lean();
    if (brand && (brand.isEmailVerified || brand.isMobileVerified)) return true;

    return false;
  }

  async updateUserImages(
    id: string,
    images: { brandLogo?: any[]; products?: any[]; profileImages?: any[] },
  ) {
    // Influencer logic (unchanged)
    let user = await this.influencerModel.findById(id);
    if (user) {
      if (images.profileImages) {
        // ...existing code for influencer...
        const shouldReviewPhoto = this.hasPrimaryProfileImageChanged(
          user.profileImages,
          images.profileImages,
        );
        user.profileImages = images.profileImages;
        await user.save();
        if (shouldReviewPhoto) {
          await this.clearProfilePhotoFlags(id, "Influencer");
        }
        if (
          Array.isArray(images.profileImages) &&
          images.profileImages.length > 1
        ) {
          await this.clearGalleryFlags(id, "Influencer");
        }
        return { message: "Influencer images updated", user };
      }
    }
    // Brand logic
    user = await this.brandModel.findById(id);
    if (user) {
      // Remove all old brand logos from Cloudinary if brandLogo is being replaced
      if (user.brandLogo && Array.isArray(user.brandLogo) && images.brandLogo) {
        for (const oldImg of user.brandLogo) {
          if (
            oldImg &&
            oldImg.public_id &&
            !images.brandLogo.some(
              (newImg) => newImg.public_id === oldImg.public_id,
            )
          ) {
            try {
              await this.cloudinaryService.deleteImage(oldImg.public_id);
            } catch (err) {
              console.error("[PATCH] Error deleting old brand logo:", err);
            }
          }
        }
      }
      // Remove all old product images from Cloudinary if products are being replaced
      if (user.products && Array.isArray(user.products) && images.products) {
        for (const oldImg of user.products) {
          if (
            oldImg &&
            oldImg.public_id &&
            !images.products.some(
              (newImg) => newImg.public_id === oldImg.public_id,
            )
          ) {
            try {
              await this.cloudinaryService.deleteImage(oldImg.public_id);
            } catch (err) {
              console.error(
                "[PATCH] Error deleting old brand product image:",
                err,
              );
            }
          }
        }
      }
      // Direct fix: always update brandLogo and products if present
      if (images.brandLogo) {
        user.brandLogo = images.brandLogo;
      }
      if (images.products) {
        user.products = images.products;
      }
      await user.save();
      if (Array.isArray(images.products) && images.products.length > 0) {
        await this.clearGalleryFlags(id, "Brand");
      }
      return { message: "Brand images updated", user };
    }
    return { message: "User not found", id };
  }

  // Helper for removing a specific influencer image (by index)
  async removeInfluencerImage(id: string, imageIdx: number) {
    const user = await this.influencerModel.findById(id);
    if (user && user.profileImages && user.profileImages[imageIdx]) {
      const img = user.profileImages[imageIdx];
      if (img && img.public_id) {
        let publicId = img.public_id;
        if (publicId && !publicId.includes("/"))
          publicId = `uploads/${publicId}`;
        try {
          await this.cloudinaryService.deleteImage(publicId);
          user.profileImages.splice(imageIdx, 1);
          await user.save();
          return { message: "Profile image removed", user };
        } catch (err) {
          console.error("[REMOVE] Error deleting influencer image:", err);
          throw new Error("Failed to remove image");
        }
      }
    }
    return { message: "Image not found or already removed" };
  }

  async registerInfluencer(dto: InfluencerProfileDto) {
    try {
      if (dto.profileImages && dto.profileImages.length) {
        const uploadedImages = [];
        for (const img of dto.profileImages) {
          const imgStr = img as unknown as string;
          const buffer = imgStr.startsWith("data:")
            ? Buffer.from(imgStr.split(",")[1], "base64")
            : fs.readFileSync(imgStr);
          const filename = randomUUID() + ".jpg";
          const filePath = path.join(LOCAL_IMAGE_DIR, filename);
          fs.writeFileSync(filePath, buffer);
          uploadedImages.push({
            url: `/assets/local-images/${filename}`,
            public_id: filename,
          });
        }

        dto.profileImages = uploadedImages;
      }
      // Hash password before saving
      if (dto.password) {
        dto.password = await bcrypt.hash(dto.password, 10);
      }
      // Save influencer to DB
      if ("price" in dto) {
        (dto as any).promotionalPrice = (dto as any).price;
        delete (dto as any).price;
      }
      const mobileOtpVerified = consumeOtpVerificationToken(
        "phone",
        (dto as any).phoneNumber,
        (dto as any).mobileOtpVerificationToken,
      );
      (dto as any).isMobileVerified = mobileOtpVerified;
      (dto as any).mobileVerified = mobileOtpVerified;
      (dto as any).mobileVerifiedAt = mobileOtpVerified ? new Date() : null;
      (dto as any).mobileVerificationMethod = mobileOtpVerified ? "OTP" : "";
      delete (dto as any).mobileOtpVerificationToken;
      (dto as any).firstRegisteredAt =
        (dto as any).firstRegisteredAt || new Date();
      const influencer = new this.influencerModel(dto);
      const savedInfluencer = await influencer.save();
      return savedInfluencer;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const field = Object.keys(
          (err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {},
        )[0];
        throw new Error(`${field} already exists`);
      }
      throw err;
    }
  }

  async registerBrand(dto: BrandProfileDto) {
    if (Array.isArray(dto.categories) && dto.categories.length > 5) {
      dto.categories = dto.categories.slice(0, 5);
    }
    try {
      if (dto.brandLogo && dto.brandLogo.length) {
        const uploadedImages = [];
        for (const img of dto.brandLogo) {
          const imgStr = img as unknown as string;
          const buffer = imgStr.startsWith("data:")
            ? Buffer.from(imgStr.split(",")[1], "base64")
            : fs.readFileSync(imgStr);
          const filename = randomUUID() + ".jpg";
          const filePath = path.join(LOCAL_IMAGE_DIR, filename);
          fs.writeFileSync(filePath, buffer);
          uploadedImages.push({
            url: `/assets/local-images/${filename}`,
            public_id: filename,
          });
        }
        dto.brandLogo = uploadedImages;
      }
      if (dto.products && dto.products.length) {
        const uploadedProducts = [];
        for (const img of dto.products) {
          const imgStr = img as unknown as string;
          const buffer = imgStr.startsWith("data:")
            ? Buffer.from(imgStr.split(",")[1], "base64")
            : fs.readFileSync(imgStr);
          const filename = randomUUID() + ".jpg";
          const filePath = path.join(LOCAL_IMAGE_DIR, filename);
          fs.writeFileSync(filePath, buffer);
          uploadedProducts.push({
            url: `/assets/local-images/${filename}`,
            public_id: filename,
          });
        }
        dto.products = uploadedProducts;
      }
      // Hash password before saving
      if (dto.password) {
        dto.password = await bcrypt.hash(dto.password, 10);
      }
      // Save brand to DB
      if ("price" in dto) {
        (dto as any).promotionalPrice = (dto as any).price;
        delete (dto as any).price;
      }
      (dto as any).firstRegisteredAt =
        (dto as any).firstRegisteredAt || new Date();
      const brand = new this.brandModel(dto);
      const savedBrand = await brand.save();
      return savedBrand;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // Find which field is duplicated
        const field = Object.keys(
          (err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {},
        )[0];
        throw new Error(`${field} already exists`);
      }
      throw err;
    }
  }

  async getInfluencers(
    page = 1,
    limit = 20,
    viewerId?: string | null,
    lite = false,
    options?: {
      state?: string;
      district?: string;
      creatorType?: string;
      viewerState?: string;
      viewerDistrict?: string;
      smartLocationPriority?: boolean;
    },
  ) {
    const skip = (page - 1) * limit;
    const stateFilter = String(options?.state || "").trim();
    const districtFilter = String(options?.district || "").trim();
    const creatorTypeFilter = String(options?.creatorType || "").trim();
    const viewerState = String(options?.viewerState || "").trim();
    const viewerDistrict = String(options?.viewerDistrict || "").trim();
    const hasManualLocationFilter = !!stateFilter || !!districtFilter;
    const useSmartLocationPriority =
      !!options?.smartLocationPriority && !hasManualLocationFilter;
    const smartLocationMeta = {
      smartLocationPriorityApplied: useSmartLocationPriority,
      manualLocationFilterApplied: hasManualLocationFilter,
      smartLocationContext: {
        viewerState: viewerState || null,
        viewerDistrict: viewerDistrict || null,
      },
    };

    const baseFilter: any = { status: "accepted" };
    const allowSocialLinks = await this.canViewerOpenSocialLinks(viewerId);
    this.applyPublicDiscoveryEligibilityFilter(baseFilter);
    this.applyExcludedIds(
      baseFilter,
      await this.publicProfileBlockedIds("Influencer"),
    );
    if (stateFilter) {
      baseFilter["location.state"] = new RegExp(
        `^${this.escapeRegex(stateFilter)}$`,
        "i",
      );
    }
    if (districtFilter) {
      baseFilter["location.district"] = new RegExp(
        `^${this.escapeRegex(districtFilter)}$`,
        "i",
      );
    }
    if (creatorTypeFilter) {
      baseFilter.creatorTypes = new RegExp(
        `^${this.escapeRegex(creatorTypeFilter)}$`,
        "i",
      );
    }

    if (lite) {
      const selection =
        "name username profileImage profileImages categories influencerCategory creatorTypes verificationStatus verifiedByTrendStarz location socialMedia collaborationAvailability adminTags isPremium premiumEnd promotionalPrice dateOfBirth";
      const [rows, total] = useSmartLocationPriority
        ? await Promise.all([
            this.influencerModel.find(baseFilter).select(selection).lean(),
            this.influencerModel.countDocuments(baseFilter),
          ])
        : await Promise.all([
            this.influencerModel
              .find(baseFilter)
              .select(selection)
              .sort({ updatedAt: -1 })
              .skip(skip)
              .limit(limit)
              .lean(),
            this.influencerModel.countDocuments(baseFilter),
          ]);

      const rankedRows = useSmartLocationPriority
        ? [...(rows || [])].sort((a: any, b: any) => {
            const scoreA = this.getLocationPriorityScore(
              a,
              viewerState,
              viewerDistrict,
            );
            const scoreB = this.getLocationPriorityScore(
              b,
              viewerState,
              viewerDistrict,
            );
            if (scoreA !== scoreB) return scoreB - scoreA;
            const followersA = this.extractTopFollowersCount(a);
            const followersB = this.extractTopFollowersCount(b);
            if (followersA !== followersB) return followersB - followersA;
            return (
              new Date(b?.updatedAt || 0).getTime() -
              new Date(a?.updatedAt || 0).getTime()
            );
          })
        : rows || [];

      const pagedRows = useSmartLocationPriority
        ? rankedRows.slice(skip, skip + limit)
        : rankedRows;

      const data = await Promise.all(
        (pagedRows || []).map(async (inf: any) => {
          const hideGallery = await this.hasOpenGalleryBlock(
            inf._id,
            "Influencer",
          );
          return {
            ...inf,
            profileImages: this.visibleInfluencerProfileImages(
              inf?.profileImages,
              hideGallery,
            ),
            isPremium: this.isCurrentlyPremium(inf),
            ageRange: this.computeAgeRangeFromDob(inf?.dateOfBirth),
            socialMedia: allowSocialLinks ? inf?.socialMedia || [] : [],
            socialMediaRestricted: !allowSocialLinks,
            dateOfBirth: undefined,
            gender: undefined,
            email: undefined,
            phoneNumber: undefined,
            website: undefined,
            contactRestricted: true,
          };
        }),
      );

      return { data, total, page, limit, ...smartLocationMeta };
    }

    // Plan caps for monthly invite reception (key reused: maxInvitesPerCampaign)
    const capByCode: Record<string, number> = {
      "influencer-free": 1,
      "influencer-pro": 10,
    };
    try {
      const { plans } = await this.plansService.listActive("INFLUENCER");
      for (const p of plans || []) {
        const lim = p?.limits?.find(
          (l: any) => l.key === "maxInvitesPerCampaign",
        )?.value;
        if (typeof lim === "number" && p?.code) {
          capByCode[p.code] = lim;
        }
      }
    } catch {
      // fall back to defaults above
    }

    const all = await this.influencerModel.find(baseFilter).lean();

    // Per-influencer monthly cycle anchored on signup (free) or premiumStart (pro)
    const now = new Date();
    const inviteCounts = await Promise.all(
      all.map(async (inf: any) => {
        const cycleStart = this.computePlanCycleStart(inf, now);
        const count = await this.campaignInviteModel.countDocuments({
          influencerId: inf._id,
          createdAt: { $gte: cycleStart },
        });
        return count;
      }),
    );

    const eligible = all.filter((inf: any, idx: number) => {
      const isPremium = this.isCurrentlyPremium(inf);
      const cap = isPremium
        ? capByCode["influencer-pro"]
        : capByCode["influencer-free"];
      if (cap === -1) return true;
      return inviteCounts[idx] < cap;
    });

    if (useSmartLocationPriority) {
      eligible.sort((a: any, b: any) => {
        const scoreA = this.getLocationPriorityScore(
          a,
          viewerState,
          viewerDistrict,
        );
        const scoreB = this.getLocationPriorityScore(
          b,
          viewerState,
          viewerDistrict,
        );
        if (scoreA !== scoreB) return scoreB - scoreA;
        const followersA = this.extractTopFollowersCount(a);
        const followersB = this.extractTopFollowersCount(b);
        if (followersA !== followersB) return followersB - followersA;
        return (
          new Date(b?.updatedAt || 0).getTime() -
          new Date(a?.updatedAt || 0).getTime()
        );
      });
    }

    const total = eligible.length;
    const pageItems = eligible.slice(skip, skip + limit);
    const data = await Promise.all(
      pageItems.map(async (inf: any) => {
        const isPremium = this.isCurrentlyPremium(inf);
        const allowContact = await this.canViewInfluencerContact(inf, viewerId);
        const hideGallery = await this.hasOpenGalleryBlock(
          inf._id,
          "Influencer",
        );
        const ageRange = this.computeAgeRangeFromDob(inf?.dateOfBirth);
        return {
          ...inf,
          profileImages: this.visibleInfluencerProfileImages(
            inf?.profileImages,
            hideGallery,
          ),
          isPremium,
          socialMedia: allowSocialLinks ? inf?.socialMedia || [] : [],
          socialMediaRestricted: !allowSocialLinks,
          ageRange,
          gender: undefined,
          verificationDocuments: undefined,
          verificationAdminNotes: undefined,
          verificationAuditLog: undefined,
          verificationDisclaimerAccepted: undefined,
          email: allowContact && inf?.isEmailVerified ? inf.email : undefined,
          phoneNumber:
            allowContact && inf?.isMobileVerified ? inf.phoneNumber : undefined,
          website: allowContact ? inf.website : undefined,
          dateOfBirth: undefined,
          contactRestricted: !allowContact,
        };
      }),
    );
    return { data, total, page, limit, ...smartLocationMeta };
  }

  private computeAgeRangeFromDob(dob: unknown): string | null {
    if (!dob) return null;
    const birth = new Date(String(dob));
    if (Number.isNaN(birth.getTime())) return null;

    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
      age--;
    }

    if (age < 0) return null;
    if (age <= 24) return "18-24";
    if (age <= 34) return "25-34";
    if (age <= 44) return "35-44";
    return "45+";
  }

  private normalizeLocationValue(value: unknown): string {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  private getLocationPriorityScore(
    user: any,
    viewerStateRaw?: string,
    viewerDistrictRaw?: string,
  ): number {
    const viewerState = this.normalizeLocationValue(viewerStateRaw);
    const viewerDistrict = this.normalizeLocationValue(viewerDistrictRaw);
    if (!viewerState) return 0;

    const userState = this.normalizeLocationValue(user?.location?.state);
    const userDistrict = this.normalizeLocationValue(user?.location?.district);

    if (viewerDistrict && userDistrict && viewerDistrict === userDistrict)
      return 100;
    if (userState && viewerState === userState) return 70;
    return 30;
  }

  private extractTopFollowersCount(user: any): number {
    const platforms = Array.isArray(user?.socialMedia) ? user.socialMedia : [];
    return platforms.reduce((max: number, sm: any) => {
      const followers = Number(sm?.followersCount || 0);
      return followers > max ? followers : max;
    }, 0);
  }

  /**
   * Per-user monthly cycle start.
   * Anchor:
   *  - Pro user with active premium → premiumStart
   *  - Otherwise → createdAt (signup)
   * The current cycle start is the latest anchor + N months that is <= now.
   */
  private computePlanCycleStart(user: any, now: Date = new Date()): Date {
    const isPremium = this.isCurrentlyPremium(user);
    const anchorRaw =
      isPremium && user?.premiumStart ? user.premiumStart : user?.createdAt;
    const anchor = anchorRaw ? new Date(anchorRaw) : new Date(0);
    if (anchor > now) return anchor;

    const cycle = new Date(anchor);
    while (true) {
      const next = new Date(cycle);
      next.setMonth(next.getMonth() + 1);
      if (next > now) break;
      cycle.setTime(next.getTime());
    }
    return cycle;
  }

  async searchInfluencers(query: {
    q?: string;
    category?: string;
    creatorType?: string;
    state?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: any = { status: "accepted" };
    this.applyPublicDiscoveryEligibilityFilter(filter);
    this.applyExcludedIds(
      filter,
      await this.publicProfileBlockedIds("Influencer"),
    );
    if (query.q) {
      const escaped = this.escapeRegex(query.q);
      filter.$or = [
        { name: new RegExp(escaped, "i") },
        { username: new RegExp(escaped, "i") },
      ];
    }
    if (query.category) {
      filter.categories = query.category;
    }
    if (query.creatorType) {
      filter.creatorTypes = new RegExp(
        `^${this.escapeRegex(query.creatorType)}$`,
        "i",
      );
    }
    if (query.state) {
      filter["location.state"] = new RegExp(
        `^${this.escapeRegex(query.state)}$`,
        "i",
      );
    }
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.influencerModel.find(filter).lean().skip(skip).limit(limit),
      this.influencerModel.countDocuments(filter),
    ]);
    const normalized = await Promise.all(
      (data || []).map(async (inf: any) => {
        const hideGallery = await this.hasOpenGalleryBlock(
          inf._id,
          "Influencer",
        );
        return {
          ...inf,
          profileImages: this.visibleInfluencerProfileImages(
            inf?.profileImages,
            hideGallery,
          ),
          isPremium: this.isCurrentlyPremium(inf),
          gender: undefined,
          dateOfBirth: undefined,
        };
      }),
    );
    return { data: normalized, total, page, limit };
  }

  // Place this inside UsersService class
  async getInfluencerByUsername(username: string, viewerId?: string | null) {
    const user: any = await this.influencerModel.findOne({ username }).lean();
    if (!user) return null;
    if (await this.hasOpenPublicProfileBlock(user._id, "Influencer"))
      return null;
    const [allowContact, allowGender, allowSocial] = await Promise.all([
      this.canViewInfluencerContact(user, viewerId),
      this.canViewInfluencerGender(user, viewerId),
      this.canViewerOpenSocialLinks(viewerId),
    ]);
    const hideGallery = await this.hasOpenGalleryBlock(user._id, "Influencer");
    const isPremium = this.isCurrentlyPremium(user);
    const {
      _id,
      name,
      username: userUsername,
      profileImage,
      profileImages,
      email,
      phoneNumber,
      website,
      categories,
      influencerCategory,
      creatorTypes,
      professionalStatus,
      expertiseArea,
      verificationStatus,
      verifiedByTrendStarz,
      location,
      socialMedia,
      collaborationAvailability,
      promotionalPrice,
      profileTraffic,
    } = user;
    return {
      _id,
      name,
      username: userUsername,
      profileImage,
      profileImages:
        hideGallery && Array.isArray(profileImages)
          ? profileImages.slice(0, 1)
          : profileImages || [],
      email: allowContact && user?.isEmailVerified ? email : undefined,
      phoneNumber:
        allowContact && user?.isMobileVerified ? phoneNumber : undefined,
      website: allowContact ? website : undefined,
      contactRestricted: !allowContact,
      categories,
      influencerCategory: influencerCategory || "",
      creatorTypes: Array.isArray(creatorTypes) ? creatorTypes : [],
      professionalStatus: !!professionalStatus,
      expertiseArea: expertiseArea || "",
      verificationStatus: verificationStatus || "not_submitted",
      verifiedByTrendStarz: !!verifiedByTrendStarz,
      location: location || { state: "" },
      socialMedia: allowSocial ? socialMedia : [],
      socialMediaRestricted: !allowSocial,
      collaborationAvailability: collaborationAvailability || null,
      isPremium,
      gender: allowGender ? user.gender || undefined : undefined,
      promotionalPrice,
      profileTraffic: profileTraffic || {
        impressions: 0,
        clicks: 0,
        lastImpressionAt: null,
        lastClickAt: null,
      },
    };
  }
  async getInfluencerById(id: string, viewerId?: string | null) {
    const user: any = await this.influencerModel.findById(id).lean();
    if (!user) return null;
    if (await this.hasOpenPublicProfileBlock(user._id, "Influencer"))
      return null;
    const [allowContact, allowGender, allowSocial] = await Promise.all([
      this.canViewInfluencerContact(user, viewerId),
      this.canViewInfluencerGender(user, viewerId),
      this.canViewerOpenSocialLinks(viewerId),
    ]);
    const hideGallery = await this.hasOpenGalleryBlock(user._id, "Influencer");
    const isPremium = this.isCurrentlyPremium(user);
    const {
      _id,
      name,
      username,
      profileImage,
      profileImages,
      email,
      phoneNumber,
      website,
      promotionalPrice,
      categories,
      influencerCategory,
      creatorTypes,
      professionalStatus,
      expertiseArea,
      verificationStatus,
      verifiedByTrendStarz,
      location,
      socialMedia,
      collaborationAvailability,
      profileTraffic,
    } = user;
    return {
      _id,
      name,
      username,
      profileImage,
      profileImages:
        hideGallery && Array.isArray(profileImages)
          ? profileImages.slice(0, 1)
          : profileImages || [],
      email: allowContact && user?.isEmailVerified ? email : undefined,
      phoneNumber:
        allowContact && user?.isMobileVerified ? phoneNumber : undefined,
      website: allowContact ? website : undefined,
      contactRestricted: !allowContact,
      categories,
      influencerCategory: influencerCategory || "",
      creatorTypes: Array.isArray(creatorTypes) ? creatorTypes : [],
      professionalStatus: !!professionalStatus,
      expertiseArea: expertiseArea || "",
      verificationStatus: verificationStatus || "not_submitted",
      verifiedByTrendStarz: !!verifiedByTrendStarz,
      location: location || { state: "" },
      socialMedia: allowSocial ? socialMedia : [],
      socialMediaRestricted: !allowSocial,
      collaborationAvailability: collaborationAvailability || null,
      isPremium,
      gender: allowGender ? user.gender || undefined : undefined,
      promotionalPrice,
      profileTraffic: profileTraffic || {
        impressions: 0,
        clicks: 0,
        lastImpressionAt: null,
        lastClickAt: null,
      },
    };
  }

  async getBrands(
    page = 1,
    limit = 20,
    viewerId?: string | null,
    lite = false,
  ) {
    const skip = (page - 1) * limit;
    const filter: any = { status: "accepted" };
    this.applyExcludedIds(filter, await this.publicProfileBlockedIds("Brand"));

    if (lite) {
      const [rows, total] = await Promise.all([
        this.brandModel
          .find(filter)
          .select(
            "brandName brandLogo categories location isPremium premiumEnd promotionalPrice adminTags socialMedia",
          )
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        this.brandModel.countDocuments(filter),
      ]);

      const data = (rows || []).map((brand: any) => ({
        ...brand,
        isPremium: this.isCurrentlyPremium(brand),
        socialMedia: Array.isArray(brand?.socialMedia)
          ? brand.socialMedia.map((sm: any) => ({
              platform: sm?.platform || "",
            }))
          : [],
        socialMediaRestricted: true,
        email: undefined,
        phoneNumber: undefined,
        website: undefined,
        contactRestricted: true,
      }));

      return { data, total, page, limit };
    }
    const [data, total] = await Promise.all([
      this.brandModel.find(filter).lean().skip(skip).limit(limit),
      this.brandModel.countDocuments(filter),
    ]);
    const filtered = await Promise.all(
      (data || []).map(async (brand: any) => {
        const { foundedYear, companySize, ...brandForList } = brand;
        const isPremium = this.isCurrentlyPremium(brand);
        const hideGallery = await this.hasOpenGalleryBlock(brand._id, "Brand");
        const visibleBrand = {
          ...brandForList,
          products: hideGallery ? [] : brandForList.products,
        };
        const allow = await this.canViewBrandSocialMedia(brand, viewerId);
        if (!allow) {
          return {
            ...visibleBrand,
            isPremium,
            socialMedia: [],
            socialMediaRestricted: true,
            email: undefined,
            phoneNumber: undefined,
            website: undefined,
            contactRestricted: true,
          };
        }
        return {
          ...visibleBrand,
          isPremium,
          email: brand?.isEmailVerified ? brand?.email : undefined,
          phoneNumber: brand?.isMobileVerified ? brand?.phoneNumber : undefined,
          socialMediaRestricted: false,
          contactRestricted: false,
        };
      }),
    );
    return { data: filtered, total, page, limit };
  }

  async acceptUser(id: string) {
    const influencer = await this.influencerModel.findByIdAndUpdate(
      id,
      { status: "accepted" },
      { new: true },
    );
    if (influencer) return { message: "User accepted", user: influencer };
    const brand = await this.brandModel.findByIdAndUpdate(
      id,
      { status: "accepted" },
      { new: true },
    );
    if (brand) return { message: "User accepted", user: brand };
    const photographer = await this.photographerModel.findByIdAndUpdate(
      id,
      { status: "accepted" },
      { new: true },
    );
    if (photographer) return { message: "User accepted", user: photographer };
    return { message: "User not found", id };
  }

  async declineUser(id: string) {
    const influencer = await this.influencerModel.findByIdAndUpdate(
      id,
      { status: "declined" },
      { new: true },
    );
    if (influencer) return { message: "User declined", user: influencer };
    const brand = await this.brandModel.findByIdAndUpdate(
      id,
      { status: "declined" },
      { new: true },
    );
    if (brand) return { message: "User declined", user: brand };
    const photographer = await this.photographerModel.findByIdAndUpdate(
      id,
      { status: "declined" },
      { new: true },
    );
    if (photographer) return { message: "User declined", user: photographer };
    return { message: "User not found", id };
  }

  async restoreUser(id: string) {
    const influencer = await this.influencerModel.findByIdAndUpdate(
      id,
      { status: "pending", isDeleted: false, deletedAt: null },
      { new: true },
    );
    if (influencer) return { message: "User restored", user: influencer };
    const brand = await this.brandModel.findByIdAndUpdate(
      id,
      { status: "pending", isDeleted: false, deletedAt: null },
      { new: true },
    );
    if (brand) return { message: "User restored", user: brand };
    const photographer = await this.photographerModel.findByIdAndUpdate(
      id,
      { status: "pending", isDeleted: false, deletedAt: null },
      { new: true },
    );
    if (photographer) return { message: "User restored", user: photographer };
    return { message: "User not found", id };
  }

  async deleteUser(id: string) {
    // Try influencer first
    let user: any = await this.influencerModel.findById(id);
    let userType: "Influencer" | "Brand" | "Photographer" | null = user
      ? "Influencer"
      : null;
    if (!user) {
      user = await this.brandModel.findById(id);
      userType = user ? "Brand" : null;
    }
    if (!user) {
      user = await this.photographerModel.findById(id);
      userType = user ? "Photographer" : null;
    }
    if (!user || !userType) return { message: "User not found", id };

    // --- SNAPSHOT LOGIC: Only if user has at least one payment, and only if deleting (soft delete) ---
    const paymentModel =
      (this as any).paymentModel || (global as any).paymentModel;
    if (paymentModel) {
      // Find all payments for this user
      const payments = await paymentModel.find({ userId: id });
      if (payments.length > 0) {
        // Build snapshot
        const userSnapshot = {
          name: user.name || user.brandName,
          email: user.email,
        };
        for (const payment of payments) {
          if (
            !payment.userSnapshot ||
            !payment.userSnapshot.name ||
            !payment.userSnapshot.email
          ) {
            payment.userSnapshot = userSnapshot;
            await payment.save();
          }
        }
      }
    }

    const publicIds = this.prepareSoftDeletedMediaSnapshot(user, userType);
    await this.removeStoredMedia(publicIds);

    // Soft delete
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.status = "deleted";
    await user.save();

    return {
      message: "User soft deleted; profile image retained and gallery/product media cleaned",
      removedImages: publicIds.length,
    };
  }
  async setPremium(
    id: string,
    isPremium: boolean,
    premiumDuration?: string,
    type?: "influencer" | "brand" | "photographer",
  ) {
    if (isPremium && !premiumDuration) {
      throw new BadRequestException(
        "premiumDuration is required when setting Premium",
      );
    }

    const update: any = { isPremium };
    if (isPremium && premiumDuration) {
      update.premiumDuration = premiumDuration;
      // Set premiumStart to now, premiumEnd based on duration
      const now = new Date();
      update.premiumStart = now;
      const end = new Date(now);
      if (premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
      else if (premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
      else if (premiumDuration === "1y") end.setFullYear(end.getFullYear() + 1);
      update.premiumEnd = end;
    } else {
      update.premiumDuration = null;
      update.premiumStart = null;
      update.premiumEnd = null;
      try {
        await this.plansService.cancelActiveSubscriptionsForUser(id);
      } catch (e) {
        console.error(
          "[ADMIN][setPremium] Failed to cancel active subscriptions:",
          e,
        );
      }
    }
    let user = null;
    let userType: "Influencer" | "Brand" | "Photographer" = "Influencer";
    if (type === "brand") {
      user = await this.brandModel.findByIdAndUpdate(id, update, { new: true });
      userType = "Brand";
    } else if (type === "photographer") {
      user = await this.photographerModel.findByIdAndUpdate(id, update, {
        new: true,
      });
      userType = "Photographer";
    } else {
      user = await this.influencerModel.findByIdAndUpdate(id, update, {
        new: true,
      });
      userType = "Influencer";
    }
    if (user && isPremium && premiumDuration) {
      // Also create/renew Subscription for plan enforcement
      try {
        const proPlan =
          await this.plansService.findProPlanForUserType(userType);
        await this.plansService.activateSubscription(
          String(user._id),
          userType,
          String(proPlan._id),
          premiumDuration as "1m" | "3m" | "1y",
          "admin",
        );
      } catch (e) {
        // Roll back legacy flags to keep user status and capabilities consistent.
        const rollback = {
          isPremium: false,
          premiumDuration: null,
          premiumStart: null,
          premiumEnd: null,
        };
        if (userType === "Brand") {
          await this.brandModel.findByIdAndUpdate(id, rollback);
        } else if (userType === "Photographer") {
          await this.photographerModel.findByIdAndUpdate(id, rollback);
        } else {
          await this.influencerModel.findByIdAndUpdate(id, rollback);
        }
        console.error(
          "[ADMIN][setPremium] Failed to activate subscription:",
          e,
        );
        throw new BadRequestException(
          "Could not grant premium. Please ensure an active Pro plan exists.",
        );
      }
      // Optionally: log somewhere that this was admin-given
    }
    if (user) return { message: "Premium status updated", user };
    return { message: "User not found", id };
  }

  async upgradeSelfPremium(
    userId: string,
    premiumDuration: "1m" | "3m" | "1y",
  ) {
    const update: any = { isPremium: true };
    update.premiumDuration = premiumDuration;
    const now = new Date();
    update.premiumStart = now;
    const end = new Date(now);
    if (premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
    else if (premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
    else if (premiumDuration === "1y") end.setFullYear(end.getFullYear() + 1);
    update.premiumEnd = end;
    // Try influencer first, then brand
    const influencer = await this.influencerModel.findByIdAndUpdate(
      userId,
      update,
      { new: true },
    );
    if (influencer)
      return {
        message: "Premium upgraded",
        user: influencer,
        userType: "influencer",
      };
    const brand = await this.brandModel.findByIdAndUpdate(userId, update, {
      new: true,
    });
    if (brand)
      return { message: "Premium upgraded", user: brand, userType: "brand" };
    return { message: "User not found", id: userId };
  }

  async getInfluencerProfileById(userId: string) {
    let user = await this.influencerModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
    if (!user.lastLoginAt) {
      const now = new Date();
      const firstRegisteredAt = user.firstRegisteredAt || user.createdAt || now;
      await this.influencerModel.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: now, firstRegisteredAt } },
      );
      user = {
        ...user,
        lastLoginAt: now,
        firstRegisteredAt,
      };
    }
    const isPremium = this.isCurrentlyPremium(user);
    return {
      _id: user._id?.toString() || user.id?.toString() || "",
      username: user.username,
      phoneNumber: user.phoneNumber,
      name: user.name,
      email: user.email,
      paymentOption: isPremium ? "premium" : "free",
      location: user.location || { state: "" },
      languages: user.languages || [],
      categories: user.categories || [],
      creatorTypes: user.creatorTypes || [],
      influencerCategory: user.influencerCategory || "",
      professionalStatus: !!user.professionalStatus,
      expertiseArea: user.expertiseArea || "",
      verificationDocuments: user.verificationDocuments || [],
      verificationStatus: user.verificationStatus || "not_submitted",
      verificationDisclaimerAccepted: !!user.verificationDisclaimerAccepted,
      verificationAdminNotes: user.verificationAdminNotes || "",
      verifiedByTrendStarz: !!user.verifiedByTrendStarz,
      verificationAuditLog: user.verificationAuditLog || [],
      adminTags: user.adminTags || [],
      dateOfBirth: user.dateOfBirth || null,
      gender: user.gender || "",
      website: user.website || "",
      googleMapAddress: user.googleMapAddress || "",
      profileImages: user.profileImages || [],
      socialMedia: user.socialMedia || [],
      adminSocialNotifications: (user.adminSocialNotifications || []).filter((n: any) => !n.seen),
      collaborationAvailability: user.collaborationAvailability || null,
      contact: user.contact || { whatsapp: false, email: false, call: false },
      isPremium,
      premiumDuration: user.premiumDuration || null,
      premiumStart: user.premiumStart || null,
      premiumEnd: user.premiumEnd || null,
      firstRegisteredAt: user.firstRegisteredAt || user.createdAt || null,
      lastLoginAt: user.lastLoginAt || null,
      lastOpenedAt: user.lastOpenedAt || null,
      promotionalPrice: user.promotionalPrice,
      payout: user.payout || {
        upiId: "",
        mobile: "",
        accountHolderName: "",
      },
      isEmailVerified: user.isEmailVerified || false,
      isMobileVerified: user.isMobileVerified || false,
    };
  }

  async dismissAdminSocialNotifications(userId: string): Promise<void> {
    await this.influencerModel.updateOne(
      { _id: userId },
      { $set: { "adminSocialNotifications.$[].seen": true } },
    );
  }

  async getBrandProfileById(userId: string) {
    let user = await this.brandModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
    if (!user.lastLoginAt) {
      const now = new Date();
      const firstRegisteredAt = user.firstRegisteredAt || user.createdAt || now;
      await this.brandModel.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: now, firstRegisteredAt } },
      );
      user = {
        ...user,
        lastLoginAt: now,
        firstRegisteredAt,
      };
    }
    const isPremium = this.isCurrentlyPremium(user);
    // Attach planCapabilities from PlansService
    let planCapabilities = null;
    try {
      planCapabilities =
        await this.plansService.getUserPlanCapabilities(userId);
    } catch {
      planCapabilities = null;
    }
    return {
      _id: user._id?.toString() || user.id?.toString() || "",
      brandName: user.brandName,
      contactPersonName: user.contactPersonName || "",
      foundedYear: user.foundedYear || null,
      companySize: user.companySize || "",
      brandUsername:
        (user as any).brandUsername || (user as any).username || "",
      phoneNumber: user.phoneNumber,
      email: user.email,
      isPremium,
      paymentOption: isPremium ? "premium" : "free",
      location: user.location || { state: "" },
      languages: user.languages || [],
      categories: user.categories || [],
      adminTags: user.adminTags || [],
      website: user.website || "",
      googleMapAddress: user.googleMapAddress || "",
      brandLogo: user.brandLogo || [],
      productImages: user.products || [],
      socialMedia: user.socialMedia || [],
      contact: user.contact || { whatsapp: false, email: false, call: false },
      promotionalPrice:
        (user as any).promotionalPrice ?? (user as any).price ?? null,
      premiumDuration: user.premiumDuration || null,
      premiumStart: user.premiumStart || null,
      premiumEnd: user.premiumEnd || null,
      firstRegisteredAt: user.firstRegisteredAt || user.createdAt || null,
      lastLoginAt: user.lastLoginAt || null,
      lastOpenedAt: user.lastOpenedAt || null,
      isEmailVerified: user.isEmailVerified || false,
      isMobileVerified: user.isMobileVerified || false,
      planCapabilities,
    };
  }

  async updateInfluencerProfile(
    userId: string,
    update: any,
    localAuthBypass = false,
  ) {
    if (update.password) delete update.password;

    // Cleanup old images if profileImages is being replaced
    if (update.profileImages) {
      const user = await this.influencerModel.findById(userId);
      if (user && user.profileImages && Array.isArray(user.profileImages)) {
        for (const oldImg of user.profileImages) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.profileImages.some(
              (img: any) => img.public_id === oldImg.public_id,
            )
          ) {
            try {
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete influencer image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
          }
        }
      }
    }

    const allowedFields = [
      "name",
      "username",
      "phoneNumber",
      "email",
      "dateOfBirth",
      "gender",
      "paymentOption",
      "location",
      "languages",
      "categories",
      "influencerCategory",
      "creatorTypes",
      "professionalStatus",
      "expertiseArea",
      "verificationDocuments",
      "verificationDisclaimerAccepted",
      "profileImages",
      "socialMedia",
      "collaborationAvailability",
      "contact",
      "promotionalPrice",
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (key === "collaborationAvailability") {
        if (update[key] !== undefined) {
          updateData.collaborationAvailability =
            normalizeCollaborationAvailability(update[key], "influencer");
        }
        continue;
      }
      if (key === "categories") {
        if (update[key] !== undefined) {
          updateData.categories = normalizeSelectionList(
            update[key],
            PROFILE_SELECTION_LIMITS.influencer.categories,
          );
        }
        continue;
      }
      if (key === "creatorTypes") {
        if (update[key] !== undefined) {
          updateData.creatorTypes = normalizeSelectionList(
            update[key],
            PROFILE_SELECTION_LIMITS.influencer.creatorTypes,
          );
        }
        continue;
      }
      if (key === "socialMedia") {
        if (update[key] !== undefined) {
          updateData.socialMedia = normalizeSocialMediaList(update[key]);
        }
        continue;
      }
      if (update[key] !== undefined) updateData[key] = update[key];
    }
    if (update.payout !== undefined) {
      updateData["payout.upiId"] = String(update?.payout?.upiId || "").trim();
      updateData["payout.mobile"] = String(update?.payout?.mobile || "").trim();
      updateData["payout.accountHolderName"] = String(
        update?.payout?.accountHolderName || "",
      ).trim();
    }
    // NOTE: isPremium is intentionally excluded — it is only set via upgradeSelfPremium or admin setPremium
    const userDoc: any = await this.influencerModel.findById(userId);
    if (!userDoc) return { message: "Influencer not found", userId };
    const shouldReviewPhoto = Object.prototype.hasOwnProperty.call(
      updateData,
      "profileImages",
    )
      ? this.hasPrimaryProfileImageChanged(
          userDoc.profileImages,
          updateData.profileImages,
        )
      : false;
    const shouldClearGallery = Object.prototype.hasOwnProperty.call(
      updateData,
      "profileImages",
    )
      ? Array.isArray(updateData.profileImages) &&
        updateData.profileImages.length > 1
      : false;

    if (Object.prototype.hasOwnProperty.call(updateData, "phoneNumber")) {
      const existingPhone = this.normalizePhone(userDoc.phoneNumber);
      const incomingPhone = this.normalizePhone(updateData.phoneNumber);
      // Verified numbers can be changed, but verification doesn't carry over —
      // the new number must be re-verified (manual call, or OTP if enabled).
      if (userDoc.isMobileVerified && existingPhone !== incomingPhone) {
        userDoc.set("previousVerifiedMobile", existingPhone);
        userDoc.set("isMobileVerified", false);
        userDoc.set("mobileVerified", false);
        userDoc.set("mobileVerifiedAt", null);
        userDoc.set("mobileVerificationDate", null);
        userDoc.set("mobileVerificationMethod", "");
        userDoc.set("mobileVerifiedBy", "");
      } else if (existingPhone !== incomingPhone) {
        userDoc.set("isMobileVerified", false);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "email")) {
      const existingEmail = this.normalizeEmail(userDoc.email);
      const incomingEmail = this.normalizeEmail(updateData.email);
      if (existingEmail !== incomingEmail) {
        if (userDoc.isEmailVerified) {
          userDoc.set("previousVerifiedEmail", existingEmail);
        }
        if (localAuthBypass) {
          // Local dev convenience: mirrors the registration/login bypass —
          // no real email provider locally, so trust the change immediately.
          userDoc.set("isEmailVerified", true);
          userDoc.set("emailVerifiedAt", new Date());
        } else {
          userDoc.set("isEmailVerified", false);
        }
      }
    }

    for (const [key, value] of Object.entries(updateData)) {
      userDoc.set(key, value);
    }

    if (updateData.verificationDocuments !== undefined) {
      const sanitizedDocs = Array.isArray(updateData.verificationDocuments)
        ? updateData.verificationDocuments
            .filter((doc: any) => doc?.url && doc?.public_id)
            .map((doc: any) => ({
              url: String(doc.url),
              public_id: String(doc.public_id),
              originalName: String(doc.originalName || ""),
              mimeType: String(doc.mimeType || ""),
              uploadedAt: doc.uploadedAt
                ? new Date(doc.uploadedAt)
                : new Date(),
            }))
        : [];

      userDoc.set("verificationDocuments", sanitizedDocs);

      const disclaimerAccepted =
        updateData.verificationDisclaimerAccepted === true ||
        userDoc.get("verificationDisclaimerAccepted") === true;

      const status =
        sanitizedDocs.length > 0 && disclaimerAccepted
          ? "pending"
          : "not_submitted";
      userDoc.set("verificationStatus", status);
      userDoc.set("verifiedByTrendStarz", false);

      const existingLog = Array.isArray(userDoc.get("verificationAuditLog"))
        ? userDoc.get("verificationAuditLog")
        : [];
      existingLog.push({
        action: sanitizedDocs.length > 0 ? "submitted" : "status_changed",
        status,
        note:
          sanitizedDocs.length > 0
            ? "Influencer submitted/updated verification documents"
            : "Influencer removed verification documents",
        actorId: String(userId || "self"),
        actorRole: "influencer",
        actedAt: new Date(),
      });
      userDoc.set("verificationAuditLog", existingLog.slice(-100));
    }

    const updated = await userDoc.save();
    if (shouldReviewPhoto) {
      await this.clearProfilePhotoFlags(userId, "Influencer");
    }
    if (shouldClearGallery) {
      await this.clearGalleryFlags(userId, "Influencer");
    }
    return { message: "Profile updated", user: updated };
  }
  async updateBrandProfile(
    userId: string,
    update: any,
    localAuthBypass = false,
  ) {
    if (update.password) delete update.password;

    // Cleanup old brandLogo images if replaced
    if (update.brandLogo) {
      const user = await this.brandModel.findById(userId);
      if (user && user.brandLogo && Array.isArray(user.brandLogo)) {
        for (const oldImg of user.brandLogo) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.brandLogo.some(
              (img: any) => img.public_id === oldImg.public_id,
            )
          ) {
            try {
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete brandLogo image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
          }
        }
      }
    }

    // Cleanup old product images if replaced
    if (update.products) {
      const user = await this.brandModel.findById(userId);
      if (user && user.products && Array.isArray(user.products)) {
        for (const oldImg of user.products) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.products.some(
              (img: any) => img.public_id === oldImg.public_id,
            )
          ) {
            try {
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete product image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
          }
        }
      }
    }

    if (Array.isArray(update.categories) && update.categories.length > 5) {
      update.categories = update.categories.slice(0, 5);
    }

    const allowedFields = [
      "brandName",
      "contactPersonName",
      "foundedYear",
      "companySize",
      "brandUsername",
      "phoneNumber",
      "email",
      "paymentOption",
      "location",
      "languages",
      "categories",
      "brandLogo",
      "products",
      "website",
      "googleMapAddress",
      "productImages",
      "socialMedia",
      "contact",
      "promotionalPrice",
      "payout",
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (key === "socialMedia") {
        if (update[key] !== undefined) {
          updateData.socialMedia = normalizeSocialMediaList(update[key]);
        }
        continue;
      }
      if (update[key] !== undefined) updateData[key] = update[key];
    }

    const existingBrand: any = await this.brandModel
      .findById(userId)
      .select("phoneNumber email isMobileVerified isEmailVerified")
      .lean();
    if (!existingBrand) return { message: "Brand not found", userId };

    if (Object.prototype.hasOwnProperty.call(updateData, "phoneNumber")) {
      const existingPhone = this.normalizePhone(existingBrand.phoneNumber);
      const incomingPhone = this.normalizePhone(updateData.phoneNumber);
      // Verified numbers can be changed, but verification doesn't carry over —
      // the new number must be re-verified (manual call, or OTP if enabled).
      if (existingBrand.isMobileVerified && existingPhone !== incomingPhone) {
        updateData.previousVerifiedMobile = existingPhone;
        updateData.isMobileVerified = false;
        updateData.mobileVerified = false;
        updateData.mobileVerifiedAt = null;
        updateData.mobileVerificationDate = null;
        updateData.mobileVerificationMethod = "";
        updateData.mobileVerifiedBy = "";
      } else if (existingPhone !== incomingPhone) {
        updateData.isMobileVerified = false;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updateData, "email")) {
      const existingEmail = this.normalizeEmail(existingBrand.email);
      const incomingEmail = this.normalizeEmail(updateData.email);
      if (existingEmail !== incomingEmail) {
        if (existingBrand.isEmailVerified) {
          updateData.previousVerifiedEmail = existingEmail;
        }
        if (localAuthBypass) {
          // Local dev convenience: mirrors the registration/login bypass —
          // no real email provider locally, so trust the change immediately.
          updateData.isEmailVerified = true;
          updateData.emailVerifiedAt = new Date();
        } else {
          updateData.isEmailVerified = false;
        }
      }
    }

    // Remove price if present
    if ("price" in updateData) delete updateData.price;
    // NOTE: isPremium is intentionally excluded — it is only set via upgradeSelfPremium or admin setPremium
    const shouldClearBrandGallery =
      Array.isArray(updateData.products) && updateData.products.length > 0;
    const updated = await this.brandModel.findByIdAndUpdate(
      userId,
      updateData,
      { new: true },
    );
    if (!updated) return { message: "Brand not found", userId };
    if (shouldClearBrandGallery) {
      await this.clearGalleryFlags(userId, "Brand");
    }
    return { message: "Profile updated", user: updated };
  }
}
