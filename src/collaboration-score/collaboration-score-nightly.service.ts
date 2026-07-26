import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { CollaborationScoreService } from "./collaboration-score.service";
import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";

type EligibleProfile = { userId: string; userType: "Influencer" | "Brand" | "Photographer" };

/**
 * Nightly bulk re-audit. Runs each eligible profile through the existing,
 * already-tested sync runAudit() path (rules-only unless aiEnabled). This is
 * a simpler substitute for the Anthropic Batches API pipeline described in
 * the plan — at current profile volumes, a per-profile loop is correct and
 * far less state to get wrong than a two-phase collect-then-poll-batch
 * flow. Swap this loop for CollaborationScoreAiService.submitBatch() /
 * pollBatchResults() once real volume actually justifies the added
 * complexity; the admin aiEnabled toggle + per-run cost logging already
 * provide the cost safety net that matters most in the meantime.
 */
@Injectable()
export class CollaborationScoreNightlyService {
  private readonly logger = new Logger(CollaborationScoreNightlyService.name);

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly settingsService: CollaborationScoreSettingsService,
    private readonly scoreService: CollaborationScoreService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async nightlyReauditCron(): Promise<void> {
    try {
      await this.maybeRunNightlyReaudit();
    } catch (err: any) {
      this.logger.error(`Nightly re-audit cron failed: ${err?.message || err}`);
    }
  }

  async maybeRunNightlyReaudit(): Promise<{ skipped: true; reason: string } | Awaited<ReturnType<CollaborationScoreNightlyService["runNightlyReaudit"]>>> {
    const settings = await this.settingsService.getSettings();
    if (!settings.nightlyReauditEnabled) return { skipped: true, reason: "disabled" };

    const now = new Date();
    if (now.getHours() !== settings.nightlyReauditCronHour) {
      return { skipped: true, reason: "not-the-configured-hour" };
    }
    if (settings.lastNightlyRunAt && this.isSameDay(new Date(settings.lastNightlyRunAt), now)) {
      return { skipped: true, reason: "already-ran-today" };
    }
    return this.runNightlyReaudit();
  }

  async runNightlyReaudit(): Promise<{ success: true; count: number; failed: number; totalCostUsd: number }> {
    const profiles = await this.eligibleProfiles();
    let count = 0;
    let failed = 0;
    let totalCostUsd = 0;

    for (const { userId, userType } of profiles) {
      try {
        const audit = await this.scoreService.runAudit(userId, userType.toLowerCase(), "SYSTEM_NIGHTLY");
        count++;
        totalCostUsd += Number(audit?.aiCostUsd || 0);
      } catch (err: any) {
        failed++;
        this.logger.warn(
          `Nightly re-audit failed for ${userType} ${userId}: ${err?.message || err}`,
        );
      }
    }

    await this.settingsService.recordNightlyRun(count, totalCostUsd);
    this.logger.log(`Nightly re-audit complete: ${count} succeeded, ${failed} failed, $${totalCostUsd.toFixed(4)} spent.`);
    return { success: true, count, failed, totalCostUsd };
  }

  private async eligibleProfiles(): Promise<EligibleProfile[]> {
    const [influencers, brands, photographers] = await Promise.all([
      this.influencerModel.find({ status: "accepted" }).select("_id").lean(),
      this.brandModel.find({ status: "accepted" }).select("_id").lean(),
      this.photographerModel.find({ status: "accepted" }).select("_id").lean(),
    ]);
    return [
      ...influencers.map((p: any) => ({ userId: String(p._id), userType: "Influencer" as const })),
      ...brands.map((p: any) => ({ userId: String(p._id), userType: "Brand" as const })),
      ...photographers.map((p: any) => ({ userId: String(p._id), userType: "Photographer" as const })),
    ];
  }

  private isSameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }
}
