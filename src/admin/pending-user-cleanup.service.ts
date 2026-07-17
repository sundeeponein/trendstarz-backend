import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import { sendAppEmail } from "../utils/app-email.service";
import { registrationReminderTemplate } from "../email/templates/auth.templates";

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

  /**
   * "Ready for soft-delete" = stalled on something the *user* controls
   * (never verified email/mobile) or was explicitly rejected (declined) —
   * never a case that's purely waiting on admin action. A user who has
   * verified both email and mobile and is just sitting in admin review is
   * deliberately excluded: the only remaining step is ours, and deleting
   * their account for a review we haven't done yet is a bad user experience,
   * not "cleanup." Those accounts stay pending indefinitely until an admin
   * accepts or declines them — see the "Awaiting Admin Approval" queue
   * instead of relying on this job for them.
   */
  private buildPendingAgeFilter(cutoff: Date) {
    return {
      status: { $in: ["pending", "declined"] },
      isDeleted: { $ne: true },
      $nor: [
        { status: "pending", isEmailVerified: true, isMobileVerified: true },
      ],
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

  /**
   * Why a given eligible user qualifies — for the dry-run preview breakdown.
   * "admin_approval_pending" never actually fires here: buildPendingAgeFilter
   * excludes the fully-verified-but-admin-pending case entirely. Kept as a
   * defensive fallback only.
   */
  private eligibilityReason(user: any): string {
    if (user?.status === "declined") return "admin_declined";
    if (user?.isEmailVerified !== true) return "email_pending";
    if (user?.isMobileVerified !== true) return "mobile_pending";
    return "admin_approval_pending";
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
      isMobileVerified: user?.isMobileVerified === true,
      reason: this.eligibilityReason(user),
      firstRegisteredAt: user?.firstRegisteredAt || null,
      createdAt: user?.createdAt || null,
      lastLoginAt: user?.lastLoginAt || null,
      lastOpenedAt: user?.lastOpenedAt || null,
    };
  }

  async getPendingUnverifiedReport(
    daysRaw: unknown = 7,
    limitRaw: unknown = 25,
  ) {
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
      ]
        .sort((a: any, b: any) => {
          const aTime = new Date(
            a.firstRegisteredAt || a.createdAt || 0,
          ).getTime();
          const bTime = new Date(
            b.firstRegisteredAt || b.createdAt || 0,
          ).getTime();
          return aTime - bTime;
        })
        .slice(0, limit),
    };
  }

  private async syncFirebaseVerifiedUser(firebaseUser: any) {
    const email = String(firebaseUser?.email || "")
      .trim()
      .toLowerCase();
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
        this.brandModel.updateOne(
          { ...filter, status: "pending" },
          activatePatch,
        ),
        this.photographerModel.updateOne(
          { ...filter, status: "pending" },
          activatePatch,
        ),
      ]);

    const adminModified = Number((adminRes as any)?.modifiedCount || 0);
    const influencerModified = Number(
      (influencerRes as any)?.modifiedCount || 0,
    );
    const brandModified = Number((brandRes as any)?.modifiedCount || 0);
    const photographerModified = Number(
      (photographerRes as any)?.modifiedCount || 0,
    );

    if (
      adminModified ||
      influencerModified ||
      brandModified ||
      photographerModified
    ) {
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
    const acceptedBrandModified = Number(
      (brandAccepted as any)?.modifiedCount || 0,
    );
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

    const firebaseUsers =
      await this.firebaseAdminService.listEmailUsers(100000);
    const verifiedUsers = firebaseUsers.filter(
      (user) => user.emailVerified === true,
    );
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

  // dryRun lists what *would* be soft-deleted without touching anything —
  // used by the admin preview endpoint so the retention window and the
  // pending/declined mix can be sanity-checked before enabling the cron.
  async runCleanupNow(triggeredBy: string = "system", dryRun = false) {
    const settings: any =
      (await this.appSettingsModel.findOne({}).lean()) || {};
    const enabled = settings.pendingUserAutoDeleteEnabled === true;
    const retentionDays = this.normalizeDays(
      settings.pendingUserAutoDeleteDays,
      45,
    );

    if (!enabled && !dryRun) {
      this.logger.log(
        "[PendingUserCleanup] Skipped: disabled in admin settings",
      );
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
    const filter = this.buildPendingAgeFilter(cutoff);
    const projection =
      "name brandName email phoneNumber status isEmailVerified isMobileVerified firstRegisteredAt createdAt";

    const [influencers, brands, photographers] = await Promise.all([
      this.influencerModel.find(filter).select(projection).lean(),
      this.brandModel.find(filter).select(projection).lean(),
      this.photographerModel.find(filter).select(projection).lean(),
    ]);

    const candidates = [
      ...influencers.map((u: any) => ({ ...u, userType: "influencer" })),
      ...brands.map((u: any) => ({ ...u, userType: "brand" })),
      ...photographers.map((u: any) => ({ ...u, userType: "photographer" })),
    ];

    const byReason: Record<string, number> = {
      admin_declined: 0,
      email_pending: 0,
      mobile_pending: 0,
      admin_approval_pending: 0,
    };
    for (const candidate of candidates) {
      byReason[this.eligibilityReason(candidate)] += 1;
    }

    const influencerCount = influencers.length;
    const brandCount = brands.length;
    const photographerCount = photographers.length;
    const totalDeleted = influencerCount + brandCount + photographerCount;

    if (!dryRun) {
      const patch = {
        $set: { status: "deleted", isDeleted: true, deletedAt: new Date() },
      };
      await Promise.all([
        this.influencerModel.updateMany(filter, patch),
        this.brandModel.updateMany(filter, patch),
        this.photographerModel.updateMany(filter, patch),
      ]);

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
        `[PendingUserCleanup] Soft-deleted ${totalDeleted} user(s) older than ${retentionDays} day(s): influencers=${influencerCount}, brands=${brandCount}, photographers=${photographerCount}, reasons=${JSON.stringify(byReason)}`,
      );
    }

    return {
      success: true,
      skipped: false,
      dryRun,
      retentionDays,
      cutoff,
      triggeredBy,
      totalDeleted,
      influencerCount,
      brandCount,
      photographerCount,
      byReason,
      users: candidates
        .slice(0, 50)
        .map((u) => this.normalizeReportUser(u, u.userType)),
    };
  }

  private ageOrClause(cutoff: Date) {
    return [
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
    ];
  }

  /**
   * User-facing nudges only — never mentions auto-delete/retention. Each
   * threshold sends at most once per account (guarded by reminderDayXSentAt),
   * so a user who verifies right after the day-7 email doesn't also get the
   * day-15 one for a step they already completed. Day 30 only fires for
   * accounts still missing email or mobile verification — same "not on the
   * user" exclusion the auto-delete filter uses, since nagging someone who's
   * just waiting on admin review isn't a "you" problem.
   */
  async sendVerificationReminders(triggeredBy: string = "system") {
    const frontendBase = (
      process.env.FRONTEND_URL || "https://www.trendstarz.in"
    ).replace(/\/$/, "");
    const loginUrl = `${frontendBase}/login`;
    const now = new Date();
    const day7Cutoff = new Date(now);
    day7Cutoff.setDate(day7Cutoff.getDate() - 7);
    const day15Cutoff = new Date(now);
    day15Cutoff.setDate(day15Cutoff.getDate() - 15);
    const day30Cutoff = new Date(now);
    day30Cutoff.setDate(day30Cutoff.getDate() - 30);

    const models = [
      this.influencerModel,
      this.brandModel,
      this.photographerModel,
    ];

    const sendBatch = async (
      model: Model<any>,
      filter: Record<string, any>,
      stage: "email" | "mobile" | "incomplete",
      sentField: string,
    ) => {
      const users = await model
        .find(filter)
        .select("email")
        .lean();
      const { subject, html, text } = registrationReminderTemplate(
        stage,
        loginUrl,
      );
      let sent = 0;
      for (const user of users as any[]) {
        if (!user.email) continue;
        try {
          await sendAppEmail({ to: user.email, subject, html, text });
          await model.updateOne(
            { _id: user._id },
            { $set: { [sentField]: now } },
          );
          sent += 1;
        } catch (err: any) {
          this.logger.error(
            `[PendingUserCleanup] Reminder email failed for ${user.email}`,
            err?.stack || err?.message || String(err),
          );
        }
      }
      return sent;
    };

    let day7 = 0;
    let day15 = 0;
    let day30 = 0;

    for (const model of models) {
      day7 += await sendBatch(
        model,
        {
          status: { $in: ["pending", "declined"] },
          isDeleted: { $ne: true },
          isEmailVerified: { $ne: true },
          reminderDay7SentAt: null,
          $or: this.ageOrClause(day7Cutoff),
        },
        "email",
        "reminderDay7SentAt",
      );

      day15 += await sendBatch(
        model,
        {
          status: { $in: ["pending", "declined"] },
          isDeleted: { $ne: true },
          isEmailVerified: true,
          isMobileVerified: { $ne: true },
          reminderDay15SentAt: null,
          $or: this.ageOrClause(day15Cutoff),
        },
        "mobile",
        "reminderDay15SentAt",
      );

      day30 += await sendBatch(
        model,
        {
          status: { $in: ["pending", "declined"] },
          isDeleted: { $ne: true },
          reminderDay30SentAt: null,
          $and: [
            { $or: [{ isEmailVerified: { $ne: true } }, { isMobileVerified: { $ne: true } }] },
            { $or: this.ageOrClause(day30Cutoff) },
          ],
        },
        "incomplete",
        "reminderDay30SentAt",
      );
    }

    const total = day7 + day15 + day30;
    await this.appSettingsModel.findOneAndUpdate(
      {},
      {
        $set: {
          registrationReminderLastRunAt: now,
          registrationReminderLastRunCounts: { day7, day15, day30 },
          registrationReminderLastRunBy: triggeredBy,
        },
      },
      { upsert: true },
    );

    this.logger.log(
      `[PendingUserCleanup] Sent ${total} registration reminder(s): day7=${day7}, day15=${day15}, day30=${day30}`,
    );

    return { success: true, triggeredBy, total, counts: { day7, day15, day30 } };
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

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async runScheduledVerificationReminders() {
    try {
      await this.sendVerificationReminders("system_cron");
    } catch (err: any) {
      this.logger.error(
        "[PendingUserCleanup] Verification reminder cron failed",
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
