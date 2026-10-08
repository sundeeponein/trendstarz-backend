import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";

type UserType = "influencer" | "brand";

@Injectable()
export class EarlyAccessAssignmentService {
  private readonly earlyAccessTag = "Early Access";
  private readonly earlyAccessDurationDays = 30;
  private readonly commissionTags = [
    "Early Access",
    "Partner",
    "Internal/Test",
  ];

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  private normalizeAdminTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return Array.from(
      new Set(
        tags.map((tag) => String(tag || "").trim()).filter((tag) => !!tag),
      ),
    );
  }

  private keepSingleCommissionTag(tags: string[]): string[] {
    const normalized = this.normalizeAdminTags(tags);
    const present = this.commissionTags.filter((tag) =>
      normalized.includes(tag),
    );
    if (present.length <= 1) {
      return normalized;
    }

    const keepTag = present.includes(this.earlyAccessTag)
      ? this.earlyAccessTag
      : present[0];
    return [
      ...normalized.filter((tag) => !this.commissionTags.includes(tag)),
      keepTag,
    ];
  }

  private getCommissionTagFromBadge(badge: string): string {
    const map: Record<string, string> = {
      early_access_creator: "Early Access",
      early_access_brand: "Early Access",
      zero_commission_creator: "Early Access",
      zero_commission_brand: "Early Access",
      partner_creator: "Partner",
      partner_brand: "Partner",
      launch_partner: "Partner",
      internal_test_creator: "Internal/Test",
      internal_test_brand: "Internal/Test",
    };
    return map[String(badge || "")] || "";
  }

  private async normalizeCommissionTagsForType(userType: UserType) {
    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;
    const users = await model
      .find({
        $or: [
          { adminTags: { $in: this.commissionTags } },
          {
            commissionBadge: {
              $in: [
                "early_access_creator",
                "early_access_brand",
                "zero_commission_creator",
                "zero_commission_brand",
                "partner_creator",
                "partner_brand",
                "launch_partner",
                "internal_test_creator",
                "internal_test_brand",
              ],
            },
          },
        ],
      })
      .select("_id adminTags commissionBadge")
      .lean();

    if (!users.length) {
      return { scannedCount: 0, updatedCount: 0 };
    }

    const bulkOps: Array<any> = [];
    for (const user of users) {
      const currentTags = this.normalizeAdminTags(user?.adminTags);
      const regularTags = currentTags.filter(
        (tag) => !this.commissionTags.includes(tag),
      );
      const badgeDerivedTag = this.getCommissionTagFromBadge(
        String(user?.commissionBadge || ""),
      );
      const fallbackTag = this.keepSingleCommissionTag(currentTags).find(
        (tag) => this.commissionTags.includes(tag),
      );
      const finalCommissionTag = badgeDerivedTag || fallbackTag || "";
      const nextTags = this.normalizeAdminTags([
        ...regularTags,
        ...(finalCommissionTag ? [finalCommissionTag] : []),
      ]);

      if (JSON.stringify(nextTags) !== JSON.stringify(currentTags)) {
        bulkOps.push({
          updateOne: {
            filter: { _id: user._id },
            update: { $set: { adminTags: nextTags } },
          },
        });
      }
    }

    if (bulkOps.length > 0) {
      await model.bulkWrite(bulkOps);
    }

    return {
      scannedCount: users.length,
      updatedCount: bulkOps.length,
    };
  }

  async normalizeExistingCommissionTags() {
    const [influencers, brands] = await Promise.all([
      this.normalizeCommissionTagsForType("influencer"),
      this.normalizeCommissionTagsForType("brand"),
    ]);

    return {
      success: true,
      influencers,
      brands,
      message:
        `Normalized ${Number(influencers.updatedCount || 0)} influencer and ` +
        `${Number(brands.updatedCount || 0)} brand records.`,
    };
  }

  private getEarlyAccessConfig(userType: UserType) {
    if (userType === "influencer") {
      return {
        cap: 50,
        badge: "early_access_creator",
        note: "Auto-assigned Early Access Creator (0% for 30 days)",
      };
    }
    return {
      cap: 20,
      badge: "early_access_brand",
      note: "Auto-assigned Launch Partner Brand (0% for 30 days)",
    };
  }

  private getDefaultCommissionOverride() {
    return {
      enabled: false,
      overrideType: "discount",
      value: 0,
      validFrom: null,
      validUntil: null,
      notes: "",
      source: "",
      assignedBy: "",
      autoGenerated: false,
      assignedAt: null,
    };
  }

  private buildEarlyAccessOverride(
    config: { note: string },
    assignedBy: string,
  ) {
    const now = new Date();
    const validUntil = new Date(now);
    validUntil.setDate(validUntil.getDate() + this.earlyAccessDurationDays);

    return {
      enabled: true,
      overrideType: "fixed",
      value: 0,
      validFrom: now,
      validUntil,
      notes: config.note,
      source: "early_access_program",
      assignedBy,
      autoGenerated: true,
      assignedAt: now,
    };
  }

  private async getEarlyAccessAssignmentMode(): Promise<"manual" | "auto"> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    return settings?.earlyAccessAssignmentMode === "auto" ? "auto" : "manual";
  }

  private async persistLastRun(
    status: "success" | "skipped" | "failed",
    details: string,
    mode: "manual" | "auto",
  ) {
    const now = new Date();
    const saved: any = await this.appSettingsModel
      .findOneAndUpdate(
        {},
        {
          $set: {
            earlyAccessLastRunAt: now,
            earlyAccessLastRunStatus: status,
            earlyAccessLastRunDetails: details,
            earlyAccessLastRunMode: mode,
          },
        },
        { upsert: true, new: true },
      )
      .lean();

    return {
      lastRunAt: saved?.earlyAccessLastRunAt || now,
      lastRunStatus: saved?.earlyAccessLastRunStatus || status,
      lastRunDetails: saved?.earlyAccessLastRunDetails || details,
      lastRunMode: saved?.earlyAccessLastRunMode || mode,
    };
  }

  private async getActiveEarlyAccessCount(
    userType: UserType,
    badge: string,
  ): Promise<number> {
    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;
    const now = new Date();

    return model.countDocuments({
      status: "accepted",
      isDeleted: { $ne: true },
      commissionBadge: badge,
      "commissionOverride.enabled": true,
      "commissionOverride.source": "early_access_program",
      $or: [
        { "commissionOverride.validFrom": null },
        { "commissionOverride.validFrom": { $lte: now } },
      ],
      $and: [
        {
          $or: [
            { "commissionOverride.validUntil": null },
            { "commissionOverride.validUntil": { $gte: now } },
          ],
        },
      ],
    });
  }

  private async releaseExpiredEarlyAccessAssignments(
    userType: UserType,
    badge: string,
  ): Promise<number> {
    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;
    const now = new Date();

    const expiredUsers = await model
      .find({
        status: "accepted",
        isDeleted: { $ne: true },
        commissionBadge: badge,
        "commissionOverride.enabled": true,
        "commissionOverride.source": "early_access_program",
        "commissionOverride.validUntil": { $lt: now },
      })
      .select("_id adminTags")
      .lean();

    if (!expiredUsers.length) {
      return 0;
    }

    const bulkOps = expiredUsers.map((user: any) => {
      const currentTags = Array.isArray(user?.adminTags) ? user.adminTags : [];
      const nextTags = this.normalizeAdminTags(
        currentTags.filter((tag: string) => tag !== this.earlyAccessTag),
      );

      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              adminTags: nextTags,
              commissionBadge: null,
              commissionOverride: this.getDefaultCommissionOverride(),
            },
          },
        },
      };
    });

    await model.bulkWrite(bulkOps);
    return bulkOps.length;
  }

  private async pickEligibleUsersForEarlyAccess(
    userType: UserType,
    limit: number,
  ): Promise<any[]> {
    if (limit <= 0) {
      return [];
    }

    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;
    return await model
      .find(this.getEarlyAccessEligibleFilter())
      .sort({ createdAt: 1 })
      .limit(limit)
      .select("_id adminTags")
      .lean();
  }

  private getEarlyAccessEligibleFilter() {
    return {
      status: "accepted",
      isDeleted: { $ne: true },
      isEmailVerified: true,
      "commissionOverride.enabled": { $ne: true },
      commissionBadge: {
        $nin: [
          "early_access_creator",
          "early_access_brand",
          "zero_commission_creator",
          "zero_commission_brand",
          "partner_creator",
          "partner_brand",
          "launch_partner",
          "internal_test_creator",
          "internal_test_brand",
        ],
      },
      adminTags: { $nin: [this.earlyAccessTag, "Partner", "Internal/Test"] },
    };
  }

  private async getEarlyAccessPreviewForType(userType: UserType) {
    const config = this.getEarlyAccessConfig(userType);
    const activeCount = await this.getActiveEarlyAccessCount(
      userType,
      config.badge,
    );
    const slotsOpen = Math.max(0, config.cap - activeCount);
    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;

    const [eligibleCount, previewUsers] = await Promise.all([
      model.countDocuments(this.getEarlyAccessEligibleFilter()),
      slotsOpen > 0
        ? model
            .find(this.getEarlyAccessEligibleFilter())
            .sort({ createdAt: 1 })
            .limit(Math.min(slotsOpen, 5))
            .select("_id name brandName email createdAt")
            .lean()
        : Promise.resolve([]),
    ]);

    return {
      cap: config.cap,
      activeCount,
      slotsOpen,
      eligibleCount,
      previewUsers,
    };
  }

  async getAutoAssignPreview() {
    const mode = await this.getEarlyAccessAssignmentMode();
    const [influencers, brands] = await Promise.all([
      this.getEarlyAccessPreviewForType("influencer"),
      this.getEarlyAccessPreviewForType("brand"),
    ]);

    return {
      success: true,
      mode,
      influencers,
      brands,
    };
  }

  private async runEarlyAccessAutoAssignmentForType(
    userType: UserType,
    assignedBy: string,
  ) {
    const config = this.getEarlyAccessConfig(userType);
    const releasedCount = await this.releaseExpiredEarlyAccessAssignments(
      userType,
      config.badge,
    );

    const activeCount = await this.getActiveEarlyAccessCount(
      userType,
      config.badge,
    );
    const slotsOpen = Math.max(0, config.cap - activeCount);
    const eligibleUsers = await this.pickEligibleUsersForEarlyAccess(
      userType,
      slotsOpen,
    );

    if (!eligibleUsers.length) {
      return {
        cap: config.cap,
        activeCount,
        slotsOpen,
        releasedCount,
        assignedCount: 0,
      };
    }

    const model =
      userType === "influencer" ? this.influencerModel : this.brandModel;
    const bulkOps = eligibleUsers.map((user: any) => {
      const currentTags = Array.isArray(user?.adminTags) ? user.adminTags : [];
      const nextTags = this.keepSingleCommissionTag([
        ...currentTags,
        this.earlyAccessTag,
      ]);

      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              adminTags: nextTags,
              commissionBadge: config.badge,
              commissionOverride: this.buildEarlyAccessOverride(
                config,
                assignedBy,
              ),
            },
          },
        },
      };
    });

    await model.bulkWrite(bulkOps);

    const updatedActiveCount = await this.getActiveEarlyAccessCount(
      userType,
      config.badge,
    );
    return {
      cap: config.cap,
      activeCount: updatedActiveCount,
      slotsOpen: Math.max(0, config.cap - updatedActiveCount),
      releasedCount,
      assignedCount: bulkOps.length,
    };
  }

  async autoAssignEarlyAccess(assignedBy: string) {
    const mode = await this.getEarlyAccessAssignmentMode();
    if (mode !== "auto") {
      const runMeta = await this.persistLastRun(
        "skipped",
        "Skipped because Early Access assignment mode is manual.",
        mode,
      );
      return {
        success: true,
        mode,
        skipped: true,
        message: "Early Access assignment mode is manual.",
        ...runMeta,
      };
    }

    const [influencers, brands] = await Promise.all([
      this.runEarlyAccessAutoAssignmentForType("influencer", assignedBy),
      this.runEarlyAccessAutoAssignmentForType("brand", assignedBy),
    ]);

    const details =
      `Assigned ${Number(influencers?.assignedCount || 0)} influencers + ` +
      `${Number(brands?.assignedCount || 0)} brands; ` +
      `Released ${Number(influencers?.releasedCount || 0)} influencer slots + ` +
      `${Number(brands?.releasedCount || 0)} brand slots.`;
    const runMeta = await this.persistLastRun("success", details, mode);

    return {
      success: true,
      mode,
      skipped: false,
      influencers,
      brands,
      ...runMeta,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async runScheduledEarlyAccessAutoAssign() {
    try {
      await this.autoAssignEarlyAccess("system_auto_refill");
    } catch (err: any) {
      // Keep scheduler resilient; log and continue next cycle.
      console.error(
        "Early Access auto-assign cron failed:",
        err?.message || err,
      );
      await this.persistLastRun(
        "failed",
        err?.message || "Unknown scheduler failure",
        "auto",
      );
    }
  }
}
