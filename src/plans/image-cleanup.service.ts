import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "./plans.service";
import { CloudinaryService } from "../cloudinary.service";
import { SingleInstance } from "../utils/single-instance";

@Injectable()
export class ImageCleanupService {
  private readonly logger = new Logger(ImageCleanupService.name);

  constructor(
    private readonly plansService: PlansService,
    private readonly cloudinaryService: CloudinaryService,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
  ) {}

  private parseRetentionDays(rawValue: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(rawValue || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getDeletedUserRetentionDays(): number {
    const fallback = this.parseRetentionDays(
      process.env.MEDIA_RETENTION_DAYS,
      45,
    );
    return this.parseRetentionDays(
      process.env.DELETED_USER_MEDIA_RETENTION_DAYS,
      fallback,
    );
  }

  private async deleteMediaByPublicIds(publicIds: string[]) {
    for (const publicId of publicIds) {
      try {
        await this.cloudinaryService.deleteImage(publicId);
      } catch (err) {
        this.logger.warn(`[ImageCleanup] Failed to delete ${publicId}`, err);
      }
    }
  }

  // Verification docs can be a PDF (Cloudinary `raw` resource) or an image,
  // unlike gallery/product media which is always `image` — each needs its
  // own resource type resolved from the stored mimeType.
  private async deleteVerificationDocuments(docs: any[]) {
    for (const doc of docs) {
      const publicId = typeof doc === "object" ? doc?.public_id : doc;
      if (!publicId) continue;
      const resourceType = doc?.mimeType === "application/pdf" ? "raw" : "image";
      try {
        await this.cloudinaryService.deleteImage(publicId, resourceType);
      } catch (err) {
        this.logger.warn(`[ImageCleanup] Failed to delete verification doc ${publicId}`, err);
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

  private softDeletedMediaToPurge(
    user: any,
    userType: "Influencer" | "Brand" | "Photographer",
  ): { publicIds: string[]; verificationDocs: any[]; update: any } {
    if (userType === "Brand") {
      const logos = Array.isArray(user?.brandLogo) ? user.brandLogo : [];
      const primaryLogo = logos[0] || null;
      return {
        publicIds: this.uniquePublicIds([
          ...logos.slice(1).map((img: any) => this.getImagePublicId(img)),
          ...(Array.isArray(user?.products)
            ? user.products.map((img: any) => this.getImagePublicId(img))
            : []),
          ...(Array.isArray(user?.galleryImages)
            ? user.galleryImages.map((img: any) => this.getImagePublicId(img))
            : []),
        ]),
        verificationDocs: [],
        update: {
          brandLogo: primaryLogo ? [primaryLogo] : [],
          products: [],
          galleryImages: [],
        },
      };
    }

    const images = Array.isArray(user?.profileImages) ? user.profileImages : [];
    const primaryImage = images[0] || null;
    const verificationDocs = Array.isArray(user?.verificationDocuments)
      ? user.verificationDocuments
      : [];
    const update: any = {
      profileImages: primaryImage ? [primaryImage] : [],
      galleryImages: [],
      verificationDocuments: [],
    };
    if (primaryImage && typeof primaryImage === "object") {
      update.profileImage =
        user.profileImage || primaryImage.url || primaryImage.secure_url || null;
      update.profileImagePublicId =
        user.profileImagePublicId ||
        primaryImage.public_id ||
        primaryImage.publicId ||
        null;
    }

    return {
      publicIds: this.uniquePublicIds([
        ...images.slice(1).map((img: any) => this.getImagePublicId(img)),
        ...(Array.isArray(user?.galleryImages)
          ? user.galleryImages.map((img: any) => this.getImagePublicId(img))
          : []),
      ]),
      verificationDocs,
      update,
    };
  }

  /** Runs daily at 2 AM */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  @SingleInstance()
  async runCleanup() {
    this.logger.log("[ImageCleanup] Starting daily image cleanup job");

    try {
      // 1. Expire stale subscriptions first
      const expired = await this.plansService.expireStaleSubscriptions();
      if (expired)
        this.logger.log(`[ImageCleanup] Expired ${expired} subscriptions`);
      const lapsed = await this.plansService.clearLapsedPremiumFlags();
      if (lapsed)
        this.logger.log(`[ImageCleanup] Cleared Premium on ${lapsed} lapsed profiles`);

      // Media of members whose Premium lapsed is kept (decided 2026-10-20): plan
      // limits only stop new uploads beyond the Free limit, and nothing is lost on renewal.
      const deletedUserRetentionDays = this.getDeletedUserRetentionDays();
      // 2. Purge lingering media for soft-deleted users after their retention window.
      await this.cleanupSoftDeletedUsers(deletedUserRetentionDays);

      this.logger.log("[ImageCleanup] Job complete");
    } catch (err) {
      this.logger.error("[ImageCleanup] Error during cleanup job", err);
    }
  }

  async cleanupSoftDeletedUsers(retentionDays: number) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const models = [
      { name: "Influencer", model: this.influencerModel },
      { name: "Brand", model: this.brandModel },
      { name: "Photographer", model: this.photographerModel },
    ];

    for (const entry of models) {
      const users = (await entry.model
        .find({ isDeleted: true, deletedAt: { $lte: cutoff } })
        .lean()) as any[];

      for (const user of users as any[]) {
        const snapshot = this.softDeletedMediaToPurge(
          user,
          entry.name as "Influencer" | "Brand" | "Photographer",
        );

        if (snapshot.publicIds.length > 0) {
          await this.deleteMediaByPublicIds(snapshot.publicIds);
        }
        if (snapshot.verificationDocs.length > 0) {
          await this.deleteVerificationDocuments(snapshot.verificationDocs);
        }

        await entry.model.findByIdAndUpdate(user._id, {
          $set: snapshot.update,
        });

        this.logger.log(
          `[ImageCleanup] Purged ${snapshot.publicIds.length} gallery/product media file(s) and ${snapshot.verificationDocs.length} verification document(s) for soft-deleted ${entry.name} ${user._id}`,
        );
      }
    }
  }
}
