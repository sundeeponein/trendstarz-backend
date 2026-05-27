import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";

@Injectable()
export class PendingUserCleanupService {
  private readonly logger = new Logger(PendingUserCleanupService.name);

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  private normalizeDays(rawValue: unknown, fallback = 45): number {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.floor(parsed);
    if (rounded < 1) return 1;
    if (rounded > 3650) return 3650;
    return rounded;
  }

  private buildPendingAgeFilter(cutoff: Date) {
    return {
      status: "pending",
      isDeleted: { $ne: true },
      $or: [
        { firstRegisteredAt: { $lte: cutoff } },
        {
          $and: [
            {
              $or: [
                { firstRegisteredAt: { $exists: false } },
                { firstRegisteredAt: null },
              ],
            },
            { createdAt: { $lte: cutoff } },
          ],
        },
      ],
    };
  }

  async runCleanupNow(triggeredBy: string = "system") {
    const settings: any = (await this.appSettingsModel.findOne({}).lean()) || {};
    const enabled = settings.pendingUserAutoDeleteEnabled === true;
    const retentionDays = this.normalizeDays(settings.pendingUserAutoDeleteDays, 45);

    if (!enabled) {
      this.logger.log("[PendingUserCleanup] Skipped: disabled in admin settings");
      return {
        success: true,
        skipped: true,
        reason: "disabled",
        retentionDays,
        triggeredBy,
      };
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const patch = {
      $set: {
        status: "deleted",
        isDeleted: true,
        deletedAt: new Date(),
      },
    };

    const [influencerRes, brandRes, photographerRes] = await Promise.all([
      this.influencerModel.updateMany(this.buildPendingAgeFilter(cutoff), patch),
      this.brandModel.updateMany(this.buildPendingAgeFilter(cutoff), patch),
      this.photographerModel.updateMany(this.buildPendingAgeFilter(cutoff), patch),
    ]);

    const influencerCount = Number((influencerRes as any)?.modifiedCount || 0);
    const brandCount = Number((brandRes as any)?.modifiedCount || 0);
    const photographerCount = Number((photographerRes as any)?.modifiedCount || 0);
    const totalDeleted = influencerCount + brandCount + photographerCount;

    await this.appSettingsModel.findOneAndUpdate(
      {},
      {
        $set: {
          pendingUserAutoDeleteLastRunAt: new Date(),
          pendingUserAutoDeleteLastRunCount: totalDeleted,
          pendingUserAutoDeleteLastRunBy: triggeredBy,
        },
      },
      { upsert: true },
    );

    this.logger.log(
      `[PendingUserCleanup] Soft-deleted ${totalDeleted} user(s) older than ${retentionDays} day(s): influencers=${influencerCount}, brands=${brandCount}, photographers=${photographerCount}`,
    );

    return {
      success: true,
      skipped: false,
      retentionDays,
      cutoff,
      triggeredBy,
      totalDeleted,
      influencerCount,
      brandCount,
      photographerCount,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduledCleanup() {
    try {
      await this.runCleanupNow("system_cron");
    } catch (err: any) {
      this.logger.error(
        "[PendingUserCleanup] Cron failed",
        err?.stack || err?.message || String(err),
      );
    }
  }
}
