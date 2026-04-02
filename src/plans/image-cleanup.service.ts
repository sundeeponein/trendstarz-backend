import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import { PlansService } from "./plans.service";

function initCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

@Injectable()
export class ImageCleanupService {
  private readonly logger = new Logger(ImageCleanupService.name);

  constructor(
    private readonly plansService: PlansService,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
  ) {}

  /** Runs daily at 2 AM */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runCleanup() {
    this.logger.log("[ImageCleanup] Starting daily image cleanup job");

    try {
      // 1. Expire stale subscriptions first
      const expired = await this.plansService.expireStaleSubscriptions();
      if (expired)
        this.logger.log(`[ImageCleanup] Expired ${expired} subscriptions`);

      // 2. Find subscriptions due for cleanup (default 45-day retention)
      const DEFAULT_RETENTION = 45;
      const subs =
        await this.plansService.getSubscriptionsForImageCleanup(
          DEFAULT_RETENTION,
        );
      this.logger.log(
        `[ImageCleanup] ${subs.length} subscriptions due for image cleanup`,
      );

      for (const sub of subs) {
        await this.cleanupImagesForUser(
          String(sub.userId),
          sub.userType,
          String(sub._id),
        );
      }

      this.logger.log("[ImageCleanup] Job complete");
    } catch (err) {
      this.logger.error("[ImageCleanup] Error during cleanup job", err);
    }
  }

  async cleanupImagesForUser(
    userId: string,
    userType: string,
    subscriptionId: string,
  ) {
    initCloudinary();

    const model =
      userType === "Influencer" ? this.influencerModel : this.brandModel;
    const imageField =
      userType === "Influencer" ? "profileImages" : "brandLogo";

    const user = (await model.findById(userId).lean()) as any;
    if (!user) {
      this.logger.warn(`[ImageCleanup] User ${userId} not found, skipping`);
      await this.plansService.markImagesDeleted(subscriptionId);
      return;
    }

    // Determine free-plan image limit (2 images)
    const freeLimit = 2;
    const images: any[] = user[imageField] ?? [];

    if (images.length <= freeLimit) {
      this.logger.log(
        `[ImageCleanup] User ${userId} within free limit, no cleanup needed`,
      );
      await this.plansService.markImagesDeleted(subscriptionId);
      return;
    }

    // Keep first `freeLimit` images, delete the rest from Cloudinary
    const toDelete = images.slice(freeLimit);
    const toKeep = images.slice(0, freeLimit);

    for (const img of toDelete) {
      const publicId = typeof img === "object" ? img.public_id : img;
      if (publicId) {
        try {
          await cloudinary.uploader.destroy(publicId);
          this.logger.log(
            `[ImageCleanup] Deleted ${publicId} for user ${userId}`,
          );
        } catch (err) {
          this.logger.warn(`[ImageCleanup] Failed to delete ${publicId}`, err);
        }
      }
    }

    // Update DB to reflect trimmed image list
    await model.findByIdAndUpdate(userId, { [imageField]: toKeep });
    await this.plansService.markImagesDeleted(subscriptionId);

    this.logger.log(
      `[ImageCleanup] Trimmed ${toDelete.length} images for user ${userId}`,
    );
  }
}
