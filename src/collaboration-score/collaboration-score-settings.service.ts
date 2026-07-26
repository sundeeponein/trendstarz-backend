import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { CollaborationScoreSettingsSnapshot } from "./collaboration-score-rules.service";

export interface CollaborationScorePlatformsEnabled {
  instagram: boolean;
  youtube: boolean;
  facebook: boolean;
  linkedin: boolean;
}

export interface CollaborationScoreSettingsDoc extends CollaborationScoreSettingsSnapshot {
  aiEnabled: boolean;
  aiModel: string;
  version2Enabled: boolean;
  platformsEnabled: CollaborationScorePlatformsEnabled;
  reanalysisCooldownDays: number;
  reanalysisFeeRupees: number;
  nightlyReauditEnabled: boolean;
  nightlyReauditCronHour: number;
  youtubeApiQuotaGuardPerDay: number;
  lastNightlyRunAt: Date | null;
  lastNightlyRunCount: number;
  lastNightlyRunCostUsd: number;
}

const DEFAULTS: CollaborationScoreSettingsDoc = {
  aiEnabled: false,
  aiModel: "claude-sonnet-5",
  weights: {
    contentQuality: { rulesPercent: 60, aiPercent: 40 },
    professionalBranding: { rulesPercent: 70, aiPercent: 30 },
  },
  thresholds: {
    trendstarzRecommendedMinScore: 80,
    campaignReadyMinScore: 70,
    partiallyReadyMinScore: 40,
  },
  version2Enabled: false,
  platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
  reanalysisCooldownDays: 30,
  reanalysisFeeRupees: 99,
  nightlyReauditEnabled: false,
  nightlyReauditCronHour: 2,
  youtubeApiQuotaGuardPerDay: 8000,
  lastNightlyRunAt: null,
  lastNightlyRunCount: 0,
  lastNightlyRunCostUsd: 0,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

@Injectable()
export class CollaborationScoreSettingsService {
  constructor(
    @InjectModel("CollaborationScoreSettings")
    private readonly settingsModel: Model<any>,
  ) {}

  async getSettings(): Promise<CollaborationScoreSettingsDoc> {
    const doc = await this.settingsModel.findOne({}).lean();
    return this.normalize(doc);
  }

  async updateSettings(body: any): Promise<CollaborationScoreSettingsDoc> {
    const current = await this.getSettings();
    const next = this.buildUpdate(body, current);
    const doc = await this.settingsModel
      .findOneAndUpdate({}, { $set: next }, { upsert: true, new: true })
      .lean();
    return this.normalize(doc);
  }

  /** Bookkeeping only — called by CollaborationScoreNightlyService after each run. */
  async recordNightlyRun(count: number, costUsd: number): Promise<void> {
    await this.settingsModel.findOneAndUpdate(
      {},
      {
        $set: {
          lastNightlyRunAt: new Date(),
          lastNightlyRunCount: count,
          lastNightlyRunCostUsd: costUsd,
        },
      },
      { upsert: true },
    );
  }

  private normalize(doc: any): CollaborationScoreSettingsDoc {
    if (!doc) return { ...DEFAULTS };
    return {
      aiEnabled: doc.aiEnabled === true,
      aiModel: String(doc.aiModel || DEFAULTS.aiModel),
      weights: {
        contentQuality: {
          rulesPercent: clampNumber(
            doc?.weights?.contentQuality?.rulesPercent,
            DEFAULTS.weights.contentQuality.rulesPercent,
            0,
            100,
          ),
          aiPercent: clampNumber(
            doc?.weights?.contentQuality?.aiPercent,
            DEFAULTS.weights.contentQuality.aiPercent,
            0,
            100,
          ),
        },
        professionalBranding: {
          rulesPercent: clampNumber(
            doc?.weights?.professionalBranding?.rulesPercent,
            DEFAULTS.weights.professionalBranding.rulesPercent,
            0,
            100,
          ),
          aiPercent: clampNumber(
            doc?.weights?.professionalBranding?.aiPercent,
            DEFAULTS.weights.professionalBranding.aiPercent,
            0,
            100,
          ),
        },
      },
      thresholds: {
        trendstarzRecommendedMinScore: clampNumber(
          doc?.thresholds?.trendstarzRecommendedMinScore,
          DEFAULTS.thresholds.trendstarzRecommendedMinScore,
          0,
          100,
        ),
        campaignReadyMinScore: clampNumber(
          doc?.thresholds?.campaignReadyMinScore,
          DEFAULTS.thresholds.campaignReadyMinScore,
          0,
          100,
        ),
        partiallyReadyMinScore: clampNumber(
          doc?.thresholds?.partiallyReadyMinScore,
          DEFAULTS.thresholds.partiallyReadyMinScore,
          0,
          100,
        ),
      },
      version2Enabled: doc.version2Enabled === true,
      platformsEnabled: {
        instagram: doc?.platformsEnabled?.instagram !== false,
        youtube: doc?.platformsEnabled?.youtube !== false,
        facebook: doc?.platformsEnabled?.facebook !== false,
        linkedin: doc?.platformsEnabled?.linkedin !== false,
      },
      reanalysisCooldownDays: clampNumber(
        doc.reanalysisCooldownDays,
        DEFAULTS.reanalysisCooldownDays,
        0,
        365,
      ),
      reanalysisFeeRupees: clampNumber(
        doc.reanalysisFeeRupees,
        DEFAULTS.reanalysisFeeRupees,
        0,
        1_000_000,
      ),
      nightlyReauditEnabled: doc.nightlyReauditEnabled === true,
      nightlyReauditCronHour: clampNumber(
        doc.nightlyReauditCronHour,
        DEFAULTS.nightlyReauditCronHour,
        0,
        23,
      ),
      youtubeApiQuotaGuardPerDay: clampNumber(
        doc.youtubeApiQuotaGuardPerDay,
        DEFAULTS.youtubeApiQuotaGuardPerDay,
        0,
        1_000_000,
      ),
      lastNightlyRunAt: doc.lastNightlyRunAt || null,
      lastNightlyRunCount: Number(doc.lastNightlyRunCount || 0),
      lastNightlyRunCostUsd: Number(doc.lastNightlyRunCostUsd || 0),
    };
  }

  private buildUpdate(body: any, current: CollaborationScoreSettingsDoc): any {
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Settings payload must be an object");
    }
    const next: any = {};
    if (body.aiEnabled !== undefined) next.aiEnabled = body.aiEnabled === true;
    if (body.version2Enabled !== undefined) next.version2Enabled = body.version2Enabled === true;
    if (body.platformsEnabled) {
      next.platformsEnabled = {
        instagram:
          body.platformsEnabled.instagram !== undefined
            ? body.platformsEnabled.instagram === true
            : current.platformsEnabled.instagram,
        youtube:
          body.platformsEnabled.youtube !== undefined
            ? body.platformsEnabled.youtube === true
            : current.platformsEnabled.youtube,
        facebook:
          body.platformsEnabled.facebook !== undefined
            ? body.platformsEnabled.facebook === true
            : current.platformsEnabled.facebook,
        linkedin:
          body.platformsEnabled.linkedin !== undefined
            ? body.platformsEnabled.linkedin === true
            : current.platformsEnabled.linkedin,
      };
    }
    if (body.reanalysisCooldownDays !== undefined) {
      next.reanalysisCooldownDays = clampNumber(
        body.reanalysisCooldownDays,
        current.reanalysisCooldownDays,
        0,
        365,
      );
    }
    if (body.reanalysisFeeRupees !== undefined) {
      next.reanalysisFeeRupees = clampNumber(
        body.reanalysisFeeRupees,
        current.reanalysisFeeRupees,
        0,
        1_000_000,
      );
    }
    if (body.nightlyReauditEnabled !== undefined) {
      next.nightlyReauditEnabled = body.nightlyReauditEnabled === true;
    }
    if (body.nightlyReauditCronHour !== undefined) {
      next.nightlyReauditCronHour = clampNumber(
        body.nightlyReauditCronHour,
        current.nightlyReauditCronHour,
        0,
        23,
      );
    }
    if (body.youtubeApiQuotaGuardPerDay !== undefined) {
      next.youtubeApiQuotaGuardPerDay = clampNumber(
        body.youtubeApiQuotaGuardPerDay,
        current.youtubeApiQuotaGuardPerDay,
        0,
        1_000_000,
      );
    }
    if (body.weights) {
      next.weights = {
        contentQuality: {
          rulesPercent: clampNumber(
            body.weights?.contentQuality?.rulesPercent,
            current.weights.contentQuality.rulesPercent,
            0,
            100,
          ),
          aiPercent: clampNumber(
            body.weights?.contentQuality?.aiPercent,
            current.weights.contentQuality.aiPercent,
            0,
            100,
          ),
        },
        professionalBranding: {
          rulesPercent: clampNumber(
            body.weights?.professionalBranding?.rulesPercent,
            current.weights.professionalBranding.rulesPercent,
            0,
            100,
          ),
          aiPercent: clampNumber(
            body.weights?.professionalBranding?.aiPercent,
            current.weights.professionalBranding.aiPercent,
            0,
            100,
          ),
        },
      };
    }
    if (body.thresholds) {
      next.thresholds = {
        trendstarzRecommendedMinScore: clampNumber(
          body.thresholds?.trendstarzRecommendedMinScore,
          current.thresholds.trendstarzRecommendedMinScore,
          0,
          100,
        ),
        campaignReadyMinScore: clampNumber(
          body.thresholds?.campaignReadyMinScore,
          current.thresholds.campaignReadyMinScore,
          0,
          100,
        ),
        partiallyReadyMinScore: clampNumber(
          body.thresholds?.partiallyReadyMinScore,
          current.thresholds.partiallyReadyMinScore,
          0,
          100,
        ),
      };
    }
    return next;
  }
}
