import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CollaborationScoreSettingsSnapshot } from "./collaboration-score-rules.service";
import { UpdateAuditSettingsDto } from "./dto/update-audit-settings.dto";
import { CURRENT_AUDIT_SETTINGS_SCHEMA_VERSION } from "../database/schemas/collaboration-score-settings.schema";
import defaultSettingsJson from "./collaboration-score-settings.default.json";

export interface CollaborationScorePlatformsEnabled {
  instagram: boolean;
  youtube: boolean;
  facebook: boolean;
  linkedin: boolean;
}

export interface CollaborationScoreAnalyticsToggles {
  trackAuditCost: boolean;
  trackAverageScore: boolean;
  trackPlatformUsage: boolean;
  trackAuditHistory: boolean;
}

export interface CollaborationScoreSettingsDoc extends CollaborationScoreSettingsSnapshot {
  schemaVersion: number;
  aiEnabled: boolean;
  aiModel: string;
  // Kill-switch for the anonymous, pre-registration YouTube preview endpoint.
  anonymousPreviewEnabled: boolean;
  // How many audits (ever) are free before an account must pay to re-analyze.
  freeAuditCount: number;
  // Stored for future use — nothing currently treats an audit as "stale"
  // past this many days; see collaboration-score-settings.service.ts.
  auditValidityDays: number;
  version2Enabled: boolean;
  version1Name: string;
  version2Name: string;
  platformsEnabled: CollaborationScorePlatformsEnabled;
  reanalysisCooldownDays: number;
  reanalysisFeeRupees: number;
  nightlyReauditEnabled: boolean;
  nightlyReauditCronHour: number;
  // Manual "Sync Latest Profile" — free comparison step gating the paid
  // Re-analyze flow. See CollaborationScoreService.syncLatestProfile.
  syncEnabled: boolean;
  syncCooldownMinutes: number;
  allowManualSync: boolean;
  requireSyncBeforeReanalysis: boolean;
  youtubeApiQuotaGuardPerDay: number;
  // Only trackAuditCost is currently wired (gates the cost fields in
  // adminList's summary/todaySummary). The other three are stored/editable
  // but not yet read anywhere — reserved for future dashboard granularity.
  analytics: CollaborationScoreAnalyticsToggles;
  lastNightlyRunAt: Date | null;
  lastNightlyRunCount: number;
  lastNightlyRunCostUsd: number;
  // Any field present in Mongo but not declared above (future settings added
  // to the JSON/DTO ahead of a code change) still round-trips — see
  // normalize()'s spread of unknownFields.
  [unknownField: string]: unknown;
}

// Single source of truth for defaults — loaded from the JSON file so the
// starting configuration is reviewable/diffable without reading TS. Any
// admin edit via PUT /api/audit/settings is layered on top of this in Mongo
// (see getSettings/updateSettings below); this file never changes at runtime.
const DEFAULTS: CollaborationScoreSettingsDoc = defaultSettingsJson as unknown as CollaborationScoreSettingsDoc;

// Every field this service explicitly knows how to normalize/validate.
// Anything else present on a Mongo doc or an update body is treated as a
// future/unknown setting and passed through as-is (see KNOWN_FIELDS usage
// below) — this is what makes new JSON settings forward-compatible without a
// code change.
const KNOWN_FIELDS = new Set([
  "_id",
  "schemaVersion",
  "aiEnabled",
  "aiModel",
  "anonymousPreviewEnabled",
  "freeAuditCount",
  "auditValidityDays",
  "weights",
  "thresholds",
  "scoreWeights",
  "version2Enabled",
  "version1Name",
  "version2Name",
  "platformsEnabled",
  "reanalysisCooldownDays",
  "reanalysisFeeRupees",
  "nightlyReauditEnabled",
  "nightlyReauditCronHour",
  "syncEnabled",
  "syncCooldownMinutes",
  "allowManualSync",
  "requireSyncBeforeReanalysis",
  "youtubeApiQuotaGuardPerDay",
  "analytics",
  "lastNightlyRunAt",
  "lastNightlyRunCount",
  "lastNightlyRunCostUsd",
  "createdAt",
  "updatedAt",
  "__v",
]);

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function unknownFieldsOf(doc: any): Record<string, unknown> {
  if (!doc) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (!KNOWN_FIELDS.has(key)) out[key] = doc[key];
  }
  return out;
}

@Injectable()
export class CollaborationScoreSettingsService implements OnModuleInit {
  private cachedSettings: CollaborationScoreSettingsDoc | null = null;
  private cacheExpiresAt = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    @InjectModel("CollaborationScoreSettings")
    private readonly settingsModel: Model<any>,
    @InjectModel("CollaborationSettingsAuditLog")
    private readonly auditLogModel: Model<any>,
  ) {}

  /** Self-heals on every boot — inserts defaults once, never touches an existing doc. */
  async onModuleInit(): Promise<void> {
    await this.dedupeSingleton();
    await this.seedDefaults();
  }

  /**
   * This collection is meant to hold exactly one document, read via
   * findOne({}) everywhere (see the schema's "Singleton doc" comment) — but
   * nothing has ever enforced that at the DB level (no unique index, no
   * fixed _id). If more than one document ever existed (e.g. a race during
   * an early deploy), findOne({}) with no sort isn't guaranteed to return
   * the same document on every call: an admin's Save could write to one
   * doc while the next page load's GET reads a different, older one — the
   * saved value appearing to silently "revert" on refresh. Keeps the most
   * recently updated document, removes any others, so every future
   * findOne({}) is unambiguous. No-op in the normal case (0 or 1 docs).
   */
  private async dedupeSingleton(): Promise<void> {
    const docs = await this.settingsModel.find({}).sort({ updatedAt: -1 }).select("_id").lean();
    if (docs.length <= 1) return;
    const [, ...extras] = docs;
    await this.settingsModel.deleteMany({ _id: { $in: extras.map((d: any) => d._id) } });
  }

  async getSettings(): Promise<CollaborationScoreSettingsDoc> {
    if (this.cachedSettings && Date.now() < this.cacheExpiresAt) {
      return this.cachedSettings;
    }
    const doc = await this.settingsModel.findOne({}).lean();
    const normalized = this.normalize(doc);
    this.cachedSettings = normalized;
    this.cacheExpiresAt = Date.now() + CollaborationScoreSettingsService.CACHE_TTL_MS;
    return normalized;
  }

  async updateSettings(body: any, actor?: { userId?: string; role?: string }): Promise<CollaborationScoreSettingsDoc> {
    const current = await this.getSettings();
    const next = await this.buildUpdate(body, current);
    const doc = await this.settingsModel
      .findOneAndUpdate({}, { $set: next }, { upsert: true, new: true })
      .lean();
    this.invalidateCache();
    const normalized = this.normalize(doc);
    await this.logChange("settings_updated", actor, Object.keys(next), current, normalized);
    return normalized;
  }

  /** Inserts the JSON defaults if no document exists yet; never overwrites an existing one. */
  async seedDefaults(): Promise<CollaborationScoreSettingsDoc> {
    const existing = await this.settingsModel.findOne({}).lean();
    if (existing) return this.normalize(existing);
    const created = await this.settingsModel.create({
      ...DEFAULTS,
      schemaVersion: CURRENT_AUDIT_SETTINGS_SCHEMA_VERSION,
    });
    this.invalidateCache();
    return this.normalize(created.toObject ? created.toObject() : created);
  }

  /** Deletes the current config and re-seeds from the JSON defaults. */
  async resetToDefaults(actor?: { userId?: string; role?: string }): Promise<CollaborationScoreSettingsDoc> {
    const before = await this.getSettings();
    await this.settingsModel.deleteMany({});
    this.invalidateCache();
    const fresh = await this.seedDefaults();
    await this.logChange("settings_reset", actor, Object.keys(DEFAULTS), before, fresh);
    return fresh;
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
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.cachedSettings = null;
    this.cacheExpiresAt = 0;
  }

  private async logChange(
    action: "settings_updated" | "settings_reset",
    actor: { userId?: string; role?: string } | undefined,
    changedFields: string[],
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await this.auditLogModel.create({
        action,
        actorId: actor?.userId || "",
        actorRole: actor?.role || "",
        changedFields,
        before,
        after,
      });
    } catch {
      // Logging must never block a settings write from succeeding.
    }
  }

  private normalize(doc: any): CollaborationScoreSettingsDoc {
    if (!doc) return { ...DEFAULTS };
    return {
      ...unknownFieldsOf(doc),
      schemaVersion: clampNumber(doc.schemaVersion, DEFAULTS.schemaVersion as number, 0, 1_000_000),
      aiEnabled: doc.aiEnabled === true,
      aiModel: String(doc.aiModel || DEFAULTS.aiModel),
      anonymousPreviewEnabled: doc.anonymousPreviewEnabled !== false,
      freeAuditCount: clampNumber(doc.freeAuditCount, DEFAULTS.freeAuditCount, 0, 100),
      auditValidityDays: clampNumber(doc.auditValidityDays, DEFAULTS.auditValidityDays, 0, 3650),
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
      scoreWeights: {
        profileCompletion: clampNumber(
          doc?.scoreWeights?.profileCompletion,
          DEFAULTS.scoreWeights.profileCompletion,
          0,
          100,
        ),
        contentQuality: clampNumber(
          doc?.scoreWeights?.contentQuality,
          DEFAULTS.scoreWeights.contentQuality,
          0,
          100,
        ),
        postingConsistency: clampNumber(
          doc?.scoreWeights?.postingConsistency,
          DEFAULTS.scoreWeights.postingConsistency,
          0,
          100,
        ),
        professionalBranding: clampNumber(
          doc?.scoreWeights?.professionalBranding,
          DEFAULTS.scoreWeights.professionalBranding,
          0,
          100,
        ),
        campaignReadiness: clampNumber(
          doc?.scoreWeights?.campaignReadiness,
          DEFAULTS.scoreWeights.campaignReadiness,
          0,
          100,
        ),
      },
      version2Enabled: doc.version2Enabled === true,
      version1Name: String(doc.version1Name || DEFAULTS.version1Name),
      version2Name: String(doc.version2Name || DEFAULTS.version2Name),
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
      syncEnabled: doc.syncEnabled !== false,
      syncCooldownMinutes: clampNumber(
        doc.syncCooldownMinutes,
        DEFAULTS.syncCooldownMinutes,
        0,
        1440,
      ),
      allowManualSync: doc.allowManualSync !== false,
      requireSyncBeforeReanalysis: doc.requireSyncBeforeReanalysis !== false,
      youtubeApiQuotaGuardPerDay: clampNumber(
        doc.youtubeApiQuotaGuardPerDay,
        DEFAULTS.youtubeApiQuotaGuardPerDay,
        0,
        1_000_000,
      ),
      analytics: {
        trackAuditCost: doc?.analytics?.trackAuditCost !== false,
        trackAverageScore: doc?.analytics?.trackAverageScore !== false,
        trackPlatformUsage: doc?.analytics?.trackPlatformUsage !== false,
        trackAuditHistory: doc?.analytics?.trackAuditHistory !== false,
      },
      lastNightlyRunAt: doc.lastNightlyRunAt || null,
      lastNightlyRunCount: Number(doc.lastNightlyRunCount || 0),
      lastNightlyRunCostUsd: Number(doc.lastNightlyRunCostUsd || 0),
    };
  }

  private async buildUpdate(body: any, current: CollaborationScoreSettingsDoc): Promise<any> {
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Settings payload must be an object");
    }

    // Validate the fields we have typed rules for. Deliberately NOT used as
    // the controller's @Body() type — see UpdateAuditSettingsDto's header
    // comment for why (global ValidationPipe would silently strip unknown
    // fields, breaking forward-compatibility).
    const dtoInstance = plainToInstance(UpdateAuditSettingsDto, body);
    const errors = await validate(dtoInstance, { whitelist: false });
    if (errors.length) {
      const messages = errors.flatMap((e) => Object.values(e.constraints || {}));
      throw new BadRequestException(messages.length ? messages : "Invalid settings payload");
    }

    const next: any = {};
    if (body.aiEnabled !== undefined) next.aiEnabled = body.aiEnabled === true;
    if (body.anonymousPreviewEnabled !== undefined) {
      next.anonymousPreviewEnabled = body.anonymousPreviewEnabled === true;
    }
    if (body.freeAuditCount !== undefined) {
      next.freeAuditCount = clampNumber(body.freeAuditCount, current.freeAuditCount, 0, 100);
    }
    if (body.auditValidityDays !== undefined) {
      next.auditValidityDays = clampNumber(body.auditValidityDays, current.auditValidityDays, 0, 3650);
    }
    if (body.version2Enabled !== undefined) next.version2Enabled = body.version2Enabled === true;
    if (body.version1Name !== undefined) next.version1Name = String(body.version1Name);
    if (body.version2Name !== undefined) next.version2Name = String(body.version2Name);
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
    if (body.syncEnabled !== undefined) next.syncEnabled = body.syncEnabled === true;
    if (body.syncCooldownMinutes !== undefined) {
      next.syncCooldownMinutes = clampNumber(body.syncCooldownMinutes, current.syncCooldownMinutes, 0, 1440);
    }
    if (body.allowManualSync !== undefined) next.allowManualSync = body.allowManualSync === true;
    if (body.requireSyncBeforeReanalysis !== undefined) {
      next.requireSyncBeforeReanalysis = body.requireSyncBeforeReanalysis === true;
    }
    if (body.youtubeApiQuotaGuardPerDay !== undefined) {
      next.youtubeApiQuotaGuardPerDay = clampNumber(
        body.youtubeApiQuotaGuardPerDay,
        current.youtubeApiQuotaGuardPerDay,
        0,
        1_000_000,
      );
    }
    if (body.analytics) {
      next.analytics = {
        trackAuditCost:
          body.analytics.trackAuditCost !== undefined
            ? body.analytics.trackAuditCost === true
            : current.analytics.trackAuditCost,
        trackAverageScore:
          body.analytics.trackAverageScore !== undefined
            ? body.analytics.trackAverageScore === true
            : current.analytics.trackAverageScore,
        trackPlatformUsage:
          body.analytics.trackPlatformUsage !== undefined
            ? body.analytics.trackPlatformUsage === true
            : current.analytics.trackPlatformUsage,
        trackAuditHistory:
          body.analytics.trackAuditHistory !== undefined
            ? body.analytics.trackAuditHistory === true
            : current.analytics.trackAuditHistory,
      };
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
      if (next.weights.contentQuality.rulesPercent + next.weights.contentQuality.aiPercent !== 100) {
        throw new BadRequestException("weights.contentQuality.rulesPercent + aiPercent must sum to 100");
      }
      if (
        next.weights.professionalBranding.rulesPercent + next.weights.professionalBranding.aiPercent !==
        100
      ) {
        throw new BadRequestException("weights.professionalBranding.rulesPercent + aiPercent must sum to 100");
      }
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
    if (body.scoreWeights) {
      next.scoreWeights = {
        profileCompletion: clampNumber(
          body.scoreWeights?.profileCompletion,
          current.scoreWeights.profileCompletion,
          0,
          100,
        ),
        contentQuality: clampNumber(
          body.scoreWeights?.contentQuality,
          current.scoreWeights.contentQuality,
          0,
          100,
        ),
        postingConsistency: clampNumber(
          body.scoreWeights?.postingConsistency,
          current.scoreWeights.postingConsistency,
          0,
          100,
        ),
        professionalBranding: clampNumber(
          body.scoreWeights?.professionalBranding,
          current.scoreWeights.professionalBranding,
          0,
          100,
        ),
        campaignReadiness: clampNumber(
          body.scoreWeights?.campaignReadiness,
          current.scoreWeights.campaignReadiness,
          0,
          100,
        ),
      };
      const sum =
        next.scoreWeights.profileCompletion +
        next.scoreWeights.contentQuality +
        next.scoreWeights.postingConsistency +
        next.scoreWeights.professionalBranding +
        next.scoreWeights.campaignReadiness;
      if (sum !== 100) {
        throw new BadRequestException(`scoreWeights must sum to 100 (got ${sum})`);
      }
    }

    // Forward-compatibility: any top-level key in the request that isn't one
    // of the known/handled settings above is stored as-is (schema is
    // strict:false — see collaboration-score-settings.schema.ts).
    for (const key of Object.keys(body)) {
      if (!KNOWN_FIELDS.has(key) && next[key] === undefined) {
        next[key] = body[key];
      }
    }

    return next;
  }
}
