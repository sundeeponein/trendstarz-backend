import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection, Model } from "mongoose";
import { YOUTUBE_STATISTICS_RETENTION_DAYS } from "../database/schemas/social-account-observation.schema";
import { SocialAccountObservationService } from "./social-account-observation.service";
import {
  HistoryAttempt,
  STOP_RUN_FAILURES,
  YOUTUBE_SCHEDULE,
  YoutubeRunPlan,
  accountKey,
  planYoutubeObservationRun,
} from "./youtube-observation-schedule";

/**
 * Stage 3D-1a — scheduled YouTube observation + statistics retention.
 *
 * Daily at 02:30 IST:
 *   1. ALWAYS: clear YouTube follower counts older than 30 days (YouTube API
 *      Services Developer Policies III.E.4) — compliance never depends on the
 *      observation switch.
 *   2. ONLY when YOUTUBE_OBSERVATION_SCHEDULE_ENABLED=true: observe the due
 *      accounts (weekly refresh), through the same exact-lookup observer the
 *      admin Fetch uses, recorded as requestedByRole "system".
 *
 * Writes only the observation collections (via SocialAccountObservationService).
 * Never touches profiles, verification, eligibility or ranking. Accounts are
 * chosen by "due" date, so a duplicate run (e.g. two instances) finds nothing
 * new to observe.
 */
export const SCHEDULE_ENV_FLAG = "YOUTUBE_OBSERVATION_SCHEDULE_ENABLED";

const PROFILE_FIELDS = {
  _id: 1,
  status: 1,
  isDeleted: 1,
  accountStatus: 1,
  isEmailVerified: 1,
  isMobileVerified: 1,
  verificationStatus: 1,
  verifiedByTrendStarz: 1,
  adminReviewPending: 1,
  socialMedia: 1,
};
const HAS_YOUTUBE = {
  isDeleted: { $ne: true },
  $or: [
    { "socialMedia.platformKey": "youtube" },
    { "socialMedia.platform": { $regex: /^\s*youtube\s*$/i } },
  ],
};

export interface YoutubeRunSummary {
  ranAt: string;
  enabled: boolean;
  retention: { currentCleared: number; historyCleared: number; cutoff: string };
  observation: {
    candidates: number;
    due: number;
    deferred: number;
    paused: number;
    attempted: number;
    succeeded: number;
    failed: Record<string, number>;
    stoppedEarly: string | null;
  } | null;
}

@Injectable()
export class YoutubeObservationSchedulerService {
  private readonly logger = new Logger(YoutubeObservationSchedulerService.name);
  private running = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel("SocialAccountObservation")
    private readonly currentModel: Model<any>,
    @InjectModel("SocialAccountObservationHistory")
    private readonly historyModel: Model<any>,
    private readonly observations: SocialAccountObservationService,
  ) {}

  static isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return String(env[SCHEDULE_ENV_FLAG] || "").toLowerCase() === "true";
  }

  @Cron("30 2 * * *", { timeZone: "Asia/Kolkata", name: "youtubeObservation" })
  async dailyCron(): Promise<void> {
    try {
      const summary = await this.run(new Date());
      if (summary)
        this.logger.log(`YouTube schedule: ${JSON.stringify(summary)}`);
    } catch (err: any) {
      this.logger.error(`YouTube schedule failed: ${err?.message || err}`);
    }
  }

  /** One run. Returns null when a run is already in progress on this instance. */
  async run(now: Date): Promise<YoutubeRunSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const purge = await this.observations.purgeExpiredYoutubeStatistics(now);
      const enabled = YoutubeObservationSchedulerService.isEnabled();
      const summary: YoutubeRunSummary = {
        ranAt: now.toISOString(),
        enabled,
        retention: {
          currentCleared: purge.current,
          historyCleared: purge.history,
          cutoff: purge.cutoff.toISOString(),
        },
        observation: null,
      };
      if (!enabled) return summary;

      const plan = await this.plan(now);
      const result = {
        candidates: plan.candidates,
        due: plan.due.length,
        deferred: plan.deferred,
        paused: plan.paused.length,
        attempted: 0,
        succeeded: 0,
        failed: {} as Record<string, number>,
        stoppedEarly: null as string | null,
      };
      for (const account of plan.due) {
        const view = await this.observations.observeScheduled({
          profileType: account.profileType,
          profileId: account.profileId,
          entry: account.entry,
        });
        result.attempted++;
        const o = view.observation;
        if (o?.status === "success" && o.lastError === null) {
          result.succeeded++;
          continue;
        }
        const reason = String(o?.lastError || "unknown");
        result.failed[reason] = (result.failed[reason] || 0) + 1;
        if ((STOP_RUN_FAILURES as readonly string[]).includes(reason)) {
          result.stoppedEarly = reason;
          break;
        }
      }
      summary.observation = result;
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Read-only: what the next run would do. Loads in bulk (3 reads). */
  async plan(now: Date): Promise<YoutubeRunPlan> {
    const [influencers, photographers, current, history] = await Promise.all([
      this.connection
        .collection("influencers")
        .find(HAS_YOUTUBE, { projection: PROFILE_FIELDS })
        .toArray(),
      this.connection
        .collection("photographers")
        .find(HAS_YOUTUBE, { projection: PROFILE_FIELDS })
        .toArray(),
      this.currentModel.find({ platformKey: "youtube" }).lean(),
      this.historyModel
        .find({ platformKey: "youtube" })
        .select(
          "profileType profileId socialAccountId status reason capturedAt",
        )
        .sort({ capturedAt: -1 })
        .lean(),
    ]);
    const currentByKey = new Map<string, Record<string, any>>(
      (current as any[]).map((d) => [
        accountKey(d.profileType, d.profileId, d.socialAccountId),
        d,
      ]),
    );
    const historyByKey = new Map<string, HistoryAttempt[]>();
    for (const h of history as any[]) {
      const key = accountKey(h.profileType, h.profileId, h.socialAccountId);
      historyByKey.set(key, [...(historyByKey.get(key) || []), h]);
    }
    return planYoutubeObservationRun({
      now,
      profiles: [
        ...influencers.map((profile) => ({
          profileType: "Influencer" as const,
          profile,
        })),
        ...photographers.map((profile) => ({
          profileType: "Photographer" as const,
          profile,
        })),
      ],
      current: currentByKey,
      history: historyByKey,
    });
  }

  /** Admin status (read-only): switch, rules, what is due/paused, retention backlog. */
  async status(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - YOUTUBE_STATISTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const [plan, lastSystem, retentionBacklog] = await Promise.all([
      this.plan(now),
      this.historyModel
        .findOne({ platformKey: "youtube", requestedByRole: "system" })
        .select("capturedAt")
        .sort({ capturedAt: -1 })
        .lean(),
      this.currentModel.countDocuments({
        source: "youtube",
        capturedAt: { $lt: cutoff },
        observedFollowersCount: { $ne: null },
      }),
    ]);
    return {
      asOf: now.toISOString(),
      enabled: YoutubeObservationSchedulerService.isEnabled(),
      switch: SCHEDULE_ENV_FLAG,
      schedule: { ...YOUTUBE_SCHEDULE, runsAt: "02:30 Asia/Kolkata daily" },
      retention: {
        maxAgeDays: YOUTUBE_STATISTICS_RETENTION_DAYS,
        countsOlderThanLimit: retentionBacklog,
      },
      lastScheduledAttemptAt: (lastSystem as any)?.capturedAt ?? null,
      candidates: plan.candidates,
      dueNow: plan.due.length + plan.deferred,
      notDue: plan.notDue,
      paused: plan.paused.map((p) => ({
        profileType: p.profileType,
        profileId: p.profileId,
        socialAccountId: p.socialAccountId,
        handle: String(p.entry?.handle ?? ""),
        consecutiveFailures: p.consecutiveFailures,
        lastError: p.lastError,
        lastAttemptAt: p.lastAttemptAt,
        nextRetryAt: p.nextRetryAt,
      })),
    };
  }
}
