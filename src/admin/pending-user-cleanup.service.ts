import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { FirebaseAdminService } from "../utils/firebase-admin.service";

@Injectable()
export class PendingUserCleanupService {
  private readonly logger = new Logger(PendingUserCleanupService.name);

  constructor(
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    private readonly firebaseAdminService: FirebaseAdminService,
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
      lastOpenedAt: user?.lastOpenedAt || null,
    };
  }

  async getPendingUnverifiedReport(daysRaw: unknown = 7, limitRaw: unknown = 25) {
    const days = this.normalizeDays(daysRaw, 7);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 25));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const filter = this.buildPendingUnverifiedAgeFilter(cutoff);
    const projection =
      "name brandName email phoneNumber status isEmailVerified firstRegisteredAt createdAt lastLoginAt lastOpenedAt";

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

  private async syncFirebaseVerifiedUser(firebaseUser: any) {
    const email = String(firebaseUser?.email || "").trim().toLowerCase();
    if (!email || firebaseUser?.emailVerified !== true) {
      return null;
    }

    const filter = {
      email,
      isEmailVerified: { $ne: true },
      isDeleted: { $ne: true },
    };
    const setPatch: any = {
      isEmailVerified: true,
      firebaseUid: firebaseUser.uid,
    };
    const activatePatch = {
      $set: {
        ...setPatch,
        status: "accepted",
      },
    };
    const adminPatch = { $set: setPatch };

    const [adminRes, influencerRes, brandRes, photographerRes] =
      await Promise.all([
        this.userModel.updateOne(filter, adminPatch),
        this.influencerModel.updateOne(
          { ...filter, status: "pending" },
          activatePatch,
        ),
        this.brandModel.updateOne({ ...filter, status: "pending" }, activatePatch),
        this.photographerModel.updateOne(
          { ...filter, status: "pending" },
          activatePatch,
        ),
      ]);

    const adminModified = Number((adminRes as any)?.modifiedCount || 0);
    const influencerModified = Number((influencerRes as any)?.modifiedCount || 0);
    const brandModified = Number((brandRes as any)?.modifiedCount || 0);
    const photographerModified = Number(
      (photographerRes as any)?.modifiedCount || 0,
    );

    if (adminModified || influencerModified || brandModified || photographerModified) {
      return {
        email,
        firebaseUid: firebaseUser.uid,
        role: adminModified
          ? "admin"
          : influencerModified
            ? "influencer"
            : brandModified
              ? "brand"
              : "photographer",
      };
    }

    const [influencerAccepted, brandAccepted, photographerAccepted] =
      await Promise.all([
        this.influencerModel.updateOne(filter, { $set: setPatch }),
        this.brandModel.updateOne(filter, { $set: setPatch }),
        this.photographerModel.updateOne(filter, { $set: setPatch }),
      ]);

    const acceptedInfluencerModified = Number(
      (influencerAccepted as any)?.modifiedCount || 0,
    );
    const acceptedBrandModified = Number((brandAccepted as any)?.modifiedCount || 0);
    const acceptedPhotographerModified = Number(
      (photographerAccepted as any)?.modifiedCount || 0,
    );

    if (
      acceptedInfluencerModified ||
      acceptedBrandModified ||
      acceptedPhotographerModified
    ) {
      return {
        email,
        firebaseUid: firebaseUser.uid,
        role: acceptedInfluencerModified
          ? "influencer"
          : acceptedBrandModified
            ? "brand"
            : "photographer",
      };
    }

    return null;
  }

  async syncFirebaseVerifiedEmails(triggeredBy: string = "system") {
    if (!this.firebaseAdminService.isConfigured()) {
      return {
        success: false,
        skipped: true,
        reason: "Firebase Admin is not configured",
        triggeredBy,
      };
    }

    const firebaseUsers = await this.firebaseAdminService.listEmailUsers(100000);
    const verifiedUsers = firebaseUsers.filter((user) => user.emailVerified === true);
    const synced: any[] = [];

    for (const firebaseUser of verifiedUsers) {
      const result = await this.syncFirebaseVerifiedUser(firebaseUser);
      if (result) synced.push(result);
    }

    const counts = synced.reduce(
      (acc: any, row: any) => {
        acc[row.role] = (acc[row.role] || 0) + 1;
        return acc;
      },
      { admin: 0, influencer: 0, brand: 0, photographer: 0 },
    );

    await this.appSettingsModel.findOneAndUpdate(
      {},
      {
        $set: {
          firebaseEmailSyncLastRunAt: new Date(),
          firebaseEmailSyncLastRunCount: synced.length,
          firebaseEmailSyncLastRunBy: triggeredBy,
          firebaseEmailSyncLastRunCounts: counts,
        },
      },
      { upsert: true },
    );

    return {
      success: true,
      skipped: false,
      triggeredBy,
      scanned: firebaseUsers.length,
      firebaseVerified: verifiedUsers.length,
      synced: synced.length,
      counts,
      users: synced.slice(0, 50),
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

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async runScheduledFirebaseEmailSync() {
    try {
      const result = await this.syncFirebaseVerifiedEmails("system_cron");
      this.logger.log(
        `[PendingUserCleanup] Firebase email sync completed: synced=${result?.synced || 0}, scanned=${result?.scanned || 0}`,
      );
    } catch (err: any) {
      this.logger.error(
        "[PendingUserCleanup] Firebase email sync cron failed",
        err?.stack || err?.message || String(err),
      );
    }
  }
}
