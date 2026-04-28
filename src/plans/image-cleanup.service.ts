import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "./plans.service";
import { CloudinaryService } from "../cloudinary.service";

@Injectable()
export class ImageCleanupService {
  private readonly logger = new Logger(ImageCleanupService.name);

  constructor(
    private readonly plansService: PlansService,
    private readonly cloudinaryService: CloudinaryService,
    @InjectModel("Subscription") private readonly subscriptionModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
  ) {}

  private parseRetentionDays(rawValue: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(rawValue || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getExpiredPremiumRetentionDays(): number {
    const fallback = this.parseRetentionDays(
      process.env.MEDIA_RETENTION_DAYS,
      45,
    );
    return this.parseRetentionDays(
      process.env.PREMIUM_MEDIA_RETENTION_DAYS,
      fallback,
    );
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

  private getSubscriptionRetentionDays(sub: any, fallback: number): number {
    const fromPolicy = sub?.policiesSnapshot?.imageRetentionDaysAfterExpiry;
    return this.parseRetentionDays(
      typeof fromPolicy === "number" ? String(fromPolicy) : undefined,
      fallback,
    );
  }

  private isSubscriptionDueForCleanup(sub: any, fallbackRetentionDays: number): boolean {
    if (!sub?.endDate) return false;

    const retentionDays = this.getSubscriptionRetentionDays(
      sub,
      fallbackRetentionDays,
    );
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    return new Date(sub.endDate) <= cutoff;
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

  private async deleteMediaByPublicIds(publicIds: string[]) {
    for (const publicId of publicIds) {
      try {
        await this.cloudinaryService.deleteImage(publicId);
      } catch (err) {
        this.logger.warn(`[ImageCleanup] Failed to delete ${publicId}`, err);
      }
    }
  }

  private clearMediaFields(user: any) {
    user.profileImage = null;
    user.profileImagePublicId = null;
    user.profileImages = [];
    user.brandLogo = [];
    user.products = [];
    user.galleryImages = [];
  }

  /** Runs daily at 2 AM */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runCleanup() {
    this.logger.log("[ImageCleanup] Starting daily image cleanup job");

    try {
      // 1. Expire stale subscriptions first
      const expired = await this.plansService.expireStaleSubscriptions();
      if (expired)
        this.logger.log(`[ImageCleanup] Expired ${expired} subscriptions`);

      // 2. Find subscriptions due for cleanup after retention window.
      const premiumRetentionDays = this.getExpiredPremiumRetentionDays();
      const deletedUserRetentionDays = this.getDeletedUserRetentionDays();
      this.logger.log(
        `[ImageCleanup] Effective retention: premiumFallback=${premiumRetentionDays} day(s), deletedUser=${deletedUserRetentionDays} day(s)`,
      );

      const candidates = await this.plansService.getSubscriptionsForImageCleanup();
      const subs = candidates.filter((sub: any) =>
        this.isSubscriptionDueForCleanup(sub, premiumRetentionDays),
      );
      this.logger.log(
        `[ImageCleanup] ${subs.length} subscriptions due for image cleanup after ${premiumRetentionDays} day(s)`,
      );

      for (const sub of subs) {
        await this.cleanupImagesForUser(
          String(sub.userId),
          sub.userType,
          String(sub._id),
        );
      }

      // 3. Purge lingering media for soft-deleted users after their retention window.
      await this.cleanupSoftDeletedUsers(deletedUserRetentionDays);

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
    const model =
      userType === "Influencer" ? this.influencerModel : this.brandModel;
    const imageField = userType === "Influencer" ? "profileImages" : "products";

    const user = (await model.findById(userId).lean()) as any;
    if (!user) {
      this.logger.warn(`[ImageCleanup] User ${userId} not found, skipping`);
      await this.plansService.markImagesDeleted(subscriptionId);
      return;
    }

    // Keep a small free-tier allowance after premium expires.
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
    const publicIds = toDelete
      .map((img) => (typeof img === "object" ? img?.public_id : img))
      .filter((value): value is string => typeof value === "string" && !!value);

    await this.deleteMediaByPublicIds(publicIds);

    // Update DB to reflect trimmed image list
    await model.findByIdAndUpdate(userId, { [imageField]: toKeep });
    await this.plansService.markImagesDeleted(subscriptionId);

    this.logger.log(
      `[ImageCleanup] Trimmed ${publicIds.length} images for user ${userId}`,
    );
  }

  async cleanupSoftDeletedUsers(retentionDays: number) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const models = [
      { name: "Influencer", model: this.influencerModel },
      { name: "Brand", model: this.brandModel },
    ];

    for (const entry of models) {
      const users = (await entry.model
        .find({ isDeleted: true, deletedAt: { $lte: cutoff } })
        .lean()) as any[];

      for (const user of users as any[]) {
        const publicIds = this.extractMediaPublicIds(user);

        if (publicIds.length > 0) {
          await this.deleteMediaByPublicIds(publicIds);
        }

        await entry.model.findByIdAndUpdate(user._id, {
          $set: {
            profileImage: null,
            profileImagePublicId: null,
            profileImages: [],
            brandLogo: [],
            products: [],
            galleryImages: [],
            status: "deleted",
          },
        });

        this.logger.log(
          `[ImageCleanup] Purged ${publicIds.length} media file(s) for soft-deleted ${entry.name} ${user._id}`,
        );
      }
    }
  }

  async previewCleanupEligibility(params: {
    userId?: string;
    subscriptionId?: string;
  }) {
    const now = new Date();
    const premiumFallbackRetentionDays = this.getExpiredPremiumRetentionDays();
    const deletedUserRetentionDays = this.getDeletedUserRetentionDays();

    let subscriptions: any[] = [];

    if (params.subscriptionId) {
      const sub = await this.subscriptionModel.findById(params.subscriptionId).lean();
      if (sub) subscriptions = [sub];
    } else if (params.userId) {
      subscriptions = await this.subscriptionModel
        .find({
          userId: params.userId,
          status: "expired",
        })
        .sort({ endDate: -1 })
        .lean();
    }

    const subscriptionPreview = subscriptions.map((sub) => {
      const retentionDays = this.getSubscriptionRetentionDays(
        sub,
        premiumFallbackRetentionDays,
      );
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - retentionDays);
      const endDate = sub?.endDate ? new Date(sub.endDate) : null;
      const isDue =
        !!endDate &&
        endDate <= cutoff &&
        !sub?.imagesMarkedForDeletionAt &&
        sub?.status === "expired";

      return {
        subscriptionId: String(sub._id),
        userId: String(sub.userId),
        userType: sub.userType,
        status: sub.status,
        endDate,
        retentionDays,
        cutoff,
        imagesMarkedForDeletionAt: sub.imagesMarkedForDeletionAt || null,
        policyRetentionDays:
          sub?.policiesSnapshot?.imageRetentionDaysAfterExpiry ?? null,
        isDueForPremiumCleanup: isDue,
      };
    });

    let softDeletedUserPreview: any = null;
    if (params.userId) {
      const influencer = await this.influencerModel.findById(params.userId).lean();
      const brand = influencer
        ? null
        : await this.brandModel.findById(params.userId).lean();
      const user: any = influencer || brand;
      const userType = influencer ? "Influencer" : brand ? "Brand" : null;

      if (user) {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - deletedUserRetentionDays);
        const deletedAt = user?.deletedAt ? new Date(user.deletedAt) : null;
        const mediaPublicIdsCount = this.extractMediaPublicIds(user).length;

        softDeletedUserPreview = {
          userId: String(user._id),
          userType,
          isDeleted: !!user.isDeleted,
          deletedAt,
          retentionDays: deletedUserRetentionDays,
          cutoff,
          mediaPublicIdsCount,
          isDueForDeletedUserMediaPurge:
            !!user.isDeleted &&
            !!deletedAt &&
            deletedAt <= cutoff &&
            mediaPublicIdsCount > 0,
        };
      }
    }

    return {
      success: true,
      now,
      settings: {
        premiumFallbackRetentionDays,
        deletedUserRetentionDays,
      },
      input: {
        userId: params.userId || null,
        subscriptionId: params.subscriptionId || null,
      },
      subscriptionPreview,
      softDeletedUserPreview,
      dryRun: true,
    };
  }
}
