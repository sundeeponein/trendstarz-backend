import { Injectable, BadRequestException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { CloudinaryService } from "../cloudinary.service";
import { InfluencerProfileDto, BrandProfileDto } from "./dto/profile.dto";
import * as bcrypt from "bcryptjs";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

const USE_LOCAL_IMAGES = process.env.USE_LOCAL_IMAGES === "true";
const LOCAL_IMAGE_DIR = path.resolve(__dirname, "../../assets/local-images");
if (USE_LOCAL_IMAGES && !fs.existsSync(LOCAL_IMAGE_DIR)) {
  fs.mkdirSync(LOCAL_IMAGE_DIR, { recursive: true });
}

@Injectable()
export class UsersService {
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

  // Only use this for GDPR requests. Otherwise, always use soft delete.
  async deletePermanently(id: string) {
    // Try influencer first
    let user = await this.influencerModel.findById(id);
    if (user) {
      const errors: any[] = [];
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
              console.log(
                `[DELETE] Deleted influencer image from Cloudinary: ${publicId}`,
              );
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
        console.log(`[CLEANUP] Influencer document deleted from DB: ${id}`);
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
        };
      }
      return { message: "Influencer permanently deleted", user };
    }
    // Try brand
    user = await this.brandModel.findById(id);
    if (user) {
      const errors: any[] = [];
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
              console.log(
                `[DELETE] Deleted brand logo from Cloudinary: ${publicId}`,
              );
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
              console.log(
                `[DELETE] Deleted brand product image from Cloudinary: ${publicId}`,
              );
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
        console.log(`[CLEANUP] Brand document deleted from DB: ${id}`);
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
        };
      }
      return { message: "Brand permanently deleted", user };
    }
    return { message: "User not found", id };
  }
  constructor(
    private readonly cloudinaryService: CloudinaryService,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

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

  async getBrandByName(brandName: string) {
    // Slugify helper
    function slugify(text: string): string {
      return text
        .toString()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");
    }

    // Use case-insensitive find instead of scanning all brands
    const decoded = slugify(brandName);
    // Try direct match (replacing hyphens with spaces for stored names)
    let user: any = await this.brandModel
      .findOne({
        brandName: new RegExp(
          `^${this.escapeRegex(brandName.replace(/-/g, " "))}$`,
          "i",
        ),
      })
      .lean();
    // Fallback: slug-based match on brandName field only
    if (!user) {
      const candidates = await this.brandModel
        .find({})
        .select("brandName")
        .lean();
      const match = candidates.find(
        (b: any) => slugify(b.brandName) === decoded,
      );
      if (match) {
        user = await this.brandModel.findById(match._id).lean();
      }
    }
    if (!user) return null;
    const {
      _id,
      brandName: name,
      email,
      phoneNumber,
      categories,
      location,
      socialMedia,
      isPremium,
      brandLogo,
      products,
      website,
      googleMapAddress,
      promotionalPrice,
      languages,
      contact,
    } = user;
    return {
      _id,
      name,
      email,
      phoneNumber,
      categories,
      location: location || { state: "" },
      socialMedia,
      isPremium,
      brandLogo,
      products,
      website,
      googleMapAddress,
      promotionalPrice,
      languages,
      contact,
    };
  }

  async updateUserImages(
    id: string,
    images: { brandLogo?: any[]; products?: any[]; profileImages?: any[] },
  ) {
    console.log(
      "[PATCH] updateUserImages called for id:",
      id,
      "with images:",
      JSON.stringify(images),
    );
    // Influencer logic (unchanged)
    let user = await this.influencerModel.findById(id);
    if (user) {
      console.log(
        "[PATCH][DEBUG] Influencer profileImages before update:",
        JSON.stringify(user.profileImages),
      );
      if (images.profileImages) {
        // ...existing code for influencer...
        user.profileImages = images.profileImages;
        await user.save();
        console.log("[PATCH] Influencer images updated:", user.profileImages);
        return { message: "Influencer images updated", user };
      }
    }
    // Brand logic
    user = await this.brandModel.findById(id);
    if (user) {
      console.log(
        "[PATCH][DEBUG] Brand brandLogo before update:",
        JSON.stringify(user.brandLogo),
      );
      console.log(
        "[PATCH][DEBUG] Brand products before update:",
        JSON.stringify(user.products),
      );
      console.log(
        "[PATCH][DEBUG] Incoming brandLogo:",
        JSON.stringify(images.brandLogo),
      );
      console.log(
        "[PATCH][DEBUG] Incoming products:",
        JSON.stringify(images.products),
      );
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
              console.log(
                "[PATCH] Deleted old brand logo from Cloudinary:",
                oldImg.public_id,
              );
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
              console.log(
                "[PATCH] Deleted old brand product image from Cloudinary:",
                oldImg.public_id,
              );
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
        console.log(
          "[PATCH][FIX] Set user.brandLogo to:",
          JSON.stringify(user.brandLogo),
        );
      }
      if (images.products) {
        user.products = images.products;
        console.log(
          "[PATCH][FIX] Set user.products to:",
          JSON.stringify(user.products),
        );
      }
      await user.save();
      console.log("[PATCH] Brand images updated:", {
        brandLogo: user.brandLogo,
        products: user.products,
      });
      return { message: "Brand images updated", user };
    }
    console.log("[PATCH] User not found for id:", id);
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
          const filename = uuidv4() + ".jpg";
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
    try {
      if (dto.brandLogo && dto.brandLogo.length) {
        const uploadedImages = [];
        for (const img of dto.brandLogo) {
          const imgStr = img as unknown as string;
          const buffer = imgStr.startsWith("data:")
            ? Buffer.from(imgStr.split(",")[1], "base64")
            : fs.readFileSync(imgStr);
          const filename = uuidv4() + ".jpg";
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
          const filename = uuidv4() + ".jpg";
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

  async getInfluencers(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.influencerModel
        .find({ status: "accepted" })
        .lean()
        .skip(skip)
        .limit(limit),
      this.influencerModel.countDocuments({ status: "accepted" }),
    ]);
    return { data, total, page, limit };
  }

  async searchInfluencers(query: {
    q?: string;
    category?: string;
    state?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: any = { status: "accepted" };
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
    return { data, total, page, limit };
  }

  // Place this inside UsersService class
  async getInfluencerByUsername(username: string) {
    const user: any = await this.influencerModel.findOne({ username }).lean();
    if (!user) return null;
    const {
      _id,
      name,
      username: userUsername,
      profileImage,
      profileImages,
      email,
      phoneNumber,
      categories,
      location,
      socialMedia,
      isPremium,
      promotionalPrice,
    } = user;
    return {
      _id,
      name,
      username: userUsername,
      profileImage,
      profileImages: profileImages || [],
      email,
      phoneNumber,
      categories,
      location: location || { state: "" },
      socialMedia,
      isPremium,
      promotionalPrice,
    };
  }
  async getInfluencerById(id: string) {
    const user: any = await this.influencerModel.findById(id).lean();
    if (!user) return null;
    const {
      _id,
      name,
      username,
      profileImage,
      profileImages,
      email,
      phoneNumber,
      promotionalPrice,
      categories,
      location,
      socialMedia,
      isPremium,
    } = user;
    return {
      _id,
      name,
      username,
      profileImage,
      profileImages: profileImages || [],
      email,
      phoneNumber,
      categories,
      location: location || { state: "" },
      socialMedia,
      isPremium,
      promotionalPrice,
    };
  }

  async getBrands(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.brandModel
        .find({ status: "accepted" })
        .lean()
        .skip(skip)
        .limit(limit),
      this.brandModel.countDocuments({ status: "accepted" }),
    ]);
    return { data, total, page, limit };
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
    return { message: "User not found", id };
  }

  async deleteUser(id: string) {
    // Try influencer first
    let user: any = await this.influencerModel.findById(id);
    if (!user) {
      user = await this.brandModel.findById(id);
    }
    if (!user) return { message: "User not found", id };

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

    // Delete profile image
    if (user.profileImagePublicId) {
      try {
        await this.cloudinaryService.deleteImage(user.profileImagePublicId);
      } catch {
        /* log error */
      }
    }
    // Delete gallery images
    if (user.galleryImages?.length) {
      for (const img of user.galleryImages) {
        if (img.publicId) {
          try {
            await this.cloudinaryService.deleteImage(img.publicId);
          } catch {
            /* log error */
          }
        }
      }
    }
    // Soft delete
    user.isDeleted = true;
    user.deletedAt = new Date();
    // Remove heavy fields
    user.profileImage = null;
    user.profileImagePublicId = null;
    user.galleryImages = [];
    await user.save();

    return { message: "User soft deleted and media cleaned" };
  }
  async setPremium(
    id: string,
    isPremium: boolean,
    premiumDuration?: string,
    type?: "influencer" | "brand",
  ) {
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
    }
    let user = null;
    let userType: "Influencer" | "Brand" = "Influencer";
    if (type === "brand") {
      user = await this.brandModel.findByIdAndUpdate(id, update, { new: true });
      userType = "Brand";
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
        // Log but do not block admin action
        console.error(
          "[ADMIN][setPremium] Failed to activate subscription:",
          e,
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
    const user = await this.influencerModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
    return {
      username: user.username,
      phoneNumber: user.phoneNumber,
      name: user.name,
      email: user.email,
      paymentOption: user.isPremium ? "premium" : "free",
      location: user.location || { state: "" },
      languages: user.languages || [],
      categories: user.categories || [],
      website: user.website || "",
      googleMapAddress: user.googleMapAddress || "",
      profileImages: user.profileImages || [],
      socialMedia: user.socialMedia || [],
      contact: user.contact || { whatsapp: false, email: false, call: false },
      isPremium: user.isPremium || false,
      premiumDuration: user.premiumDuration || null,
      premiumStart: user.premiumStart || null,
      premiumEnd: user.premiumEnd || null,
      promotionalPrice: user.promotionalPrice,
      isEmailVerified: user.isEmailVerified || false,
      isMobileVerified: user.isMobileVerified || false,
    };
  }

  async getBrandProfileById(userId: string) {
    const user = await this.brandModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
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
      brandUsername:
        (user as any).brandUsername || (user as any).username || "",
      phoneNumber: user.phoneNumber,
      email: user.email,
      isPremium: user.isPremium || false,
      paymentOption: user.isPremium ? "premium" : "free",
      location: user.location || { state: "" },
      languages: user.languages || [],
      categories: user.categories || [],
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
      isEmailVerified: user.isEmailVerified || false,
      isMobileVerified: user.isMobileVerified || false,
      planCapabilities,
    };
  }

  async updateInfluencerProfile(userId: string, update: any) {
    if (update.password) delete update.password;

    // Cleanup old images if profileImages is being replaced
    if (update.profileImages) {
      const user = await this.influencerModel.findById(userId);
      console.log("[PATCH][DEBUG] updateInfluencerProfile: userId:", userId);
      console.log(
        "[PATCH][DEBUG] Old profileImages:",
        user && user.profileImages
          ? JSON.stringify(user.profileImages)
          : "none",
      );
      console.log(
        "[PATCH][DEBUG] New profileImages:",
        JSON.stringify(update.profileImages),
      );
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
              console.log(
                "[PATCH][DEBUG] Deleting old influencer image with public_id:",
                oldImg.public_id,
              );
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
              console.log(
                "[PATCH][DEBUG] Cloudinary delete result for",
                oldImg.public_id,
                ":",
                result,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete influencer image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
            console.log(
              "[PATCH][DEBUG] Keeping image (still present):",
              oldImg && oldImg.public_id,
            );
          }
        }
      }
    }

    const allowedFields = [
      "name",
      "username",
      "phoneNumber",
      "email",
      "paymentOption",
      "location",
      "languages",
      "categories",
      "profileImages",
      "socialMedia",
      "contact",
      "promotionalPrice",
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (update[key] !== undefined) updateData[key] = update[key];
    }
    // NOTE: isPremium is intentionally excluded — it is only set via upgradeSelfPremium or admin setPremium
    const updated = await this.influencerModel.findByIdAndUpdate(
      userId,
      updateData,
      { new: true },
    );
    if (!updated) return { message: "Influencer not found", userId };
    return { message: "Profile updated", user: updated };
  }
  async updateBrandProfile(userId: string, update: any) {
    if (update.password) delete update.password;

    // Cleanup old brandLogo images if replaced
    if (update.brandLogo) {
      const user = await this.brandModel.findById(userId);
      console.log("[PATCH][DEBUG] updateBrandProfile: userId:", userId);
      console.log(
        "[PATCH][DEBUG] Old brandLogo:",
        user && user.brandLogo ? JSON.stringify(user.brandLogo) : "none",
      );
      console.log(
        "[PATCH][DEBUG] New brandLogo:",
        JSON.stringify(update.brandLogo),
      );
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
              console.log(
                "[PATCH][DEBUG] Deleting old brandLogo image with public_id:",
                oldImg.public_id,
              );
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
              console.log(
                "[PATCH][DEBUG] Cloudinary delete result for brandLogo",
                oldImg.public_id,
                ":",
                result,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete brandLogo image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
            console.log(
              "[PATCH][DEBUG] Keeping brandLogo image (still present):",
              oldImg && oldImg.public_id,
            );
          }
        }
      }
    }

    // Cleanup old product images if replaced
    if (update.products) {
      const user = await this.brandModel.findById(userId);
      console.log(
        "[PATCH][DEBUG] Old products:",
        user && user.products ? JSON.stringify(user.products) : "none",
      );
      console.log(
        "[PATCH][DEBUG] New products:",
        JSON.stringify(update.products),
      );
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
              console.log(
                "[PATCH][DEBUG] Deleting old product image with public_id:",
                oldImg.public_id,
              );
              const result = await this.cloudinaryService.deleteImage(
                oldImg.public_id,
              );
              console.log(
                "[PATCH][DEBUG] Cloudinary delete result for product",
                oldImg.public_id,
                ":",
                result,
              );
            } catch (err) {
              console.error(
                "[PATCH][ERROR] Failed to delete product image:",
                oldImg.public_id,
                err,
              );
            }
          } else {
            console.log(
              "[PATCH][DEBUG] Keeping product image (still present):",
              oldImg && oldImg.public_id,
            );
          }
        }
      }
    }

    const allowedFields = [
      "brandName",
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
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (update[key] !== undefined) updateData[key] = update[key];
    }
    // Remove price if present
    if ("price" in updateData) delete updateData.price;
    // NOTE: isPremium is intentionally excluded — it is only set via upgradeSelfPremium or admin setPremium
    const updated = await this.brandModel.findByIdAndUpdate(
      userId,
      updateData,
      { new: true },
    );
    if (!updated) return { message: "Brand not found", userId };
    return { message: "Profile updated", user: updated };
  }
}
