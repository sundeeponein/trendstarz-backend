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

  private buildPendingUnverifiedAgeFilter(cutoff: Date) {
    return {
      ...this.buildPendingAgeFilter(cutoff),
      isEmailVerified: { $ne: true },
    };
  }

  private normalizeReportUser(user: any, userType: string) {
    return {
      id: String(user?._id || ""),
      userType,
      name: user?.brandName || user?.name || "",
      email: user?.email || "",
      phoneNumber: user?.phoneNumber || "",
      status: user?.status || "pending",
      isEmailVerified: user?.isEmailVerified === true,
      firstRegisteredAt: user?.firstRegisteredAt || null,
      createdAt: user?.createdAt || null,
      lastLoginAt: user?.lastLoginAt || null,
    };
  }

  async getPendingUnverifiedReport(daysRaw: unknown = 7, limitRaw: unknown = 25) {
    const days = this.normalizeDays(daysRaw, 7);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 25));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const filter = this.buildPendingUnverifiedAgeFilter(cutoff);
    const projection =
      "name brandName email phoneNumber status isEmailVerified firstRegisteredAt createdAt lastLoginAt";

    const [
      influencerCount,
      brandCount,
      photographerCount,
      influencers,
      brands,
      photographers,
    ] = await Promise.all([
      this.influencerModel.countDocuments(filter),
      this.brandModel.countDocuments(filter),
      this.photographerModel.countDocuments(filter),
      this.influencerModel
        .find(filter)
        .select(projection)
        .sort({ firstRegisteredAt: 1, createdAt: 1, _id: 1 })
        .lean()
        .limit(limit),
      this.brandModel
        .find(filter)
        .select(projection)
        .sort({ firstRegisteredAt: 1, createdAt: 1, _id: 1 })
        .lean()
        .limit(limit),
      this.photographerModel
        .find(filter)
        .select(projection)
        .sort({ firstRegisteredAt: 1, createdAt: 1, _id: 1 })
        .lean()
        .limit(limit),
    ]);

    const total = influencerCount + brandCount + photographerCount;
    return {
      success: true,
      days,
      cutoff,
      total,
      counts: {
        influencers: influencerCount,
        brands: brandCount,
        photographers: photographerCount,
      },
      users: [
        ...(influencers || []).map((u: any) =>
          this.normalizeReportUser(u, "influencer"),
        ),
        ...(brands || []).map((u: any) => this.normalizeReportUser(u, "brand")),
        ...(photographers || []).map((u: any) =>
          this.normalizeReportUser(u, "photographer"),
        ),
      ].sort((a: any, b: any) => {
        const aTime = new Date(a.firstRegisteredAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.firstRegisteredAt || b.createdAt || 0).getTime();
        return aTime - bTime;
      }).slice(0, limit),
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

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async runScheduledPendingUnverifiedReport() {
    try {
      const report = await this.getPendingUnverifiedReport(7, 25);
      await this.appSettingsModel.findOneAndUpdate(
        {},
        {
          $set: {
            pendingUnverifiedReportLastRunAt: new Date(),
            pendingUnverifiedReportLastRunCount: report.total,
            pendingUnverifiedReportLastRunCounts: report.counts,
          },
        },
        { upsert: true },
      );
      this.logger.log(
        `[PendingUserCleanup] Pending unverified report: total=${report.total}, influencers=${report.counts.influencers}, brands=${report.counts.brands}, photographers=${report.counts.photographers}`,
      );
    } catch (err: any) {
      this.logger.error(
        "[PendingUserCleanup] Pending unverified report cron failed",
        err?.stack || err?.message || String(err),
      );
    }
  }
}
