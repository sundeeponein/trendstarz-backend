import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  ObservationFailureReason,
  ObservationSource,
  ObservationStatus,
  YOUTUBE_STATISTICS_PURGE_OPTION,
  YOUTUBE_STATISTICS_RETENTION_DAYS,
} from "../database/schemas/social-account-observation.schema";
import { SocialProfileType } from "../database/schemas/social-account-verification.schema";
import {
  derivePlatformKey,
  isSocialAccountId,
} from "../utils/social-account.util";
import {
  MetaObserver,
  ObservationOutcome,
  ObservedAccountData,
  YoutubeObserver,
} from "./platform-observers";

/**
 * Stage 3A-2 — Platform Data Observation (OBSERVED only).
 *
 * Records what YouTube / Instagram / Facebook report about ONE social account,
 * addressed by its stable socialAccountId. Writes only
 * social_account_observations (latest successful observation + latest attempt)
 * and social_account_observation_history (append-only). Never writes the
 * profile (handle, tier, followersCount, selfReportedStats), never reads or
 * writes Stage 3A-1 verification, never compares declared vs observed.
 */

const ADMIN_ROLES = ["admin", "subadmin"];

export interface SocialAccountObservationView {
  socialAccountId: string | null;
  platform: string;
  platformKey: string;
  /** Whether this platform can be observed at all. */
  observable: boolean;
  /** Instagram/Facebook: Meta only shares data once the creator connects the account. */
  requiresConnection: boolean;
  /** For requiresConnection platforms: whether the creator has connected it. null otherwise. */
  connected: boolean | null;
  observation: {
    status: ObservationStatus;
    lastError: ObservationFailureReason | null;
    lastAttemptAt: Date | null;
    /** The latest SUCCESSFUL observation; null if there has never been one. */
    latest: {
      source: ObservationSource;
      externalAccountId: string;
      observedHandle: string;
      observedFollowersCount: number | null;
      externalUrl: string;
      rawPlatformUpdatedAt: Date | null;
      capturedAt: Date;
    } | null;
  } | null;
}

const OBSERVABLE_PLATFORMS = ["youtube", "instagram", "facebook"] as const;
const CONNECTION_PLATFORMS: readonly string[] = ["instagram", "facebook"];

function plain(entry: unknown): Record<string, any> {
  if (!entry || typeof entry !== "object") return {};
  const e = entry as { toObject?: () => Record<string, any> };
  return typeof e.toObject === "function"
    ? e.toObject()
    : (entry as Record<string, any>);
}

/** Exactly the observed fields — whatever else an observer returns is never persisted. */
function observedFields(data: ObservedAccountData): ObservedAccountData {
  return {
    source: data.source,
    externalAccountId: String(data.externalAccountId),
    observedHandle: String(data.observedHandle),
    observedFollowersCount: data.observedFollowersCount ?? null,
    externalUrl: String(data.externalUrl),
    rawPlatformUpdatedAt: data.rawPlatformUpdatedAt ?? null,
  };
}

function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function platformKeyOf(entry: Record<string, any>): string {
  return String(entry.platformKey || derivePlatformKey(entry.platform));
}

@Injectable()
export class SocialAccountObservationService {
  constructor(
    @InjectModel("SocialAccountObservation")
    private readonly currentModel: Model<any>,
    @InjectModel("SocialAccountObservationHistory")
    private readonly historyModel: Model<any>,
    private readonly youtube: YoutubeObserver,
    private readonly meta: MetaObserver,
  ) {}

  /** Observes ONE social account now (admin-triggered) and records the outcome. */
  async observe(
    actor: unknown,
    params: {
      profileType: SocialProfileType;
      profileId: string;
      entry: unknown;
    },
  ): Promise<SocialAccountObservationView> {
    const a = (actor || {}) as {
      role?: unknown;
      userId?: unknown;
      id?: unknown;
    };
    const role = scalarText(a.role).toLowerCase();
    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException("Admin access only");
    }
    return this.record(params, {
      id: scalarText(a.userId) || scalarText(a.id),
      role,
    });
  }

  /**
   * Stage 3D-1a — the same observation, requested by the YouTube schedule.
   * Recorded in history as requestedByRole "system" (no admin user involved).
   * Identical rules otherwise: exact identifier only, observed fields only.
   */
  async observeScheduled(params: {
    profileType: SocialProfileType;
    profileId: string;
    entry: unknown;
  }): Promise<SocialAccountObservationView> {
    return this.record(params, { id: "", role: "system" });
  }

  /**
   * Stage 3D-1a — YouTube statistics retention (Developer Policies III.E.4).
   * Clears follower counts captured more than 30 days before `now` from the
   * current records and from history (the one permitted history update).
   * Identity, status and timestamps are kept; nothing is deleted.
   */
  async purgeExpiredYoutubeStatistics(
    now: Date,
  ): Promise<{ current: number; history: number; cutoff: Date }> {
    const cutoff = new Date(
      now.getTime() - YOUTUBE_STATISTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const filter = {
      source: "youtube",
      capturedAt: { $lt: cutoff },
      observedFollowersCount: { $ne: null },
    };
    const update = {
      $set: { observedFollowersCount: null, statisticsPurgedAt: now },
    };
    const current = await this.currentModel.updateMany(filter, update);
    // Custom query option read by the history append-only hook (mongoose
    // passes unknown options through to getOptions()).
    // timestamps:false — the purge must not add timestamp fields (and the
    // append-only hook accepts exactly the two $set fields, nothing else).
    const purgeOption = {
      retentionPurge: YOUTUBE_STATISTICS_PURGE_OPTION,
      timestamps: false,
    } as Record<string, unknown>;
    const history = await this.historyModel.updateMany(
      filter,
      update,
      purgeOption,
    );
    return {
      current: Number(current?.modifiedCount ?? 0),
      history: Number(history?.modifiedCount ?? 0),
      cutoff,
    };
  }

  private async record(
    params: {
      profileType: SocialProfileType;
      profileId: string;
      entry: unknown;
    },
    requester: { id: string; role: string },
  ): Promise<SocialAccountObservationView> {
    const role = requester.role;
    const { profileType, profileId } = params;
    const entry = plain(params.entry);
    const socialAccountId: unknown = entry.socialAccountId;
    if (!isSocialAccountId(socialAccountId)) {
      throw new BadRequestException("Invalid social account id");
    }
    const platformKey = platformKeyOf(entry);

    const outcome = await this.fetch(
      platformKey,
      profileType,
      profileId,
      entry.handle,
    );

    // Server time only — never a browser or platform timestamp.
    const now = new Date();
    const filter = { profileType, profileId, socialAccountId };
    const requestedById = requester.id;

    if (outcome.ok) {
      await this.currentModel.findOneAndUpdate(
        filter,
        {
          $set: {
            platformKey,
            ...observedFields(outcome.data),
            capturedAt: now,
            status: "success",
            lastError: null,
            lastAttemptAt: now,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else {
      // A failure never erases the last successful observation.
      await this.currentModel.findOneAndUpdate(
        filter,
        {
          $set: {
            platformKey,
            status: "failed",
            lastError: outcome.reason,
            lastAttemptAt: now,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }

    await this.historyModel.create({
      ...filter,
      platformKey,
      status: outcome.ok ? "success" : "failed",
      reason: outcome.ok ? null : outcome.reason,
      ...(outcome.ok ? observedFields(outcome.data) : {}),
      capturedAt: now,
      requestedById,
      requestedByRole: role,
    });

    const current = await this.currentModel.findOne(filter).lean();
    return this.view(entry, current);
  }

  /** Current observation for every social account on a profile (admin view). */
  async listForProfile(
    profileType: SocialProfileType,
    profileId: string,
    socialMedia: unknown,
  ): Promise<SocialAccountObservationView[]> {
    const entries = (Array.isArray(socialMedia) ? socialMedia : []).map(plain);
    const docs: any[] = await this.currentModel
      .find({ profileType, profileId })
      .lean();
    const byId = new Map(docs.map((d) => [String(d.socialAccountId), d]));
    const needsMeta = entries.some((e) =>
      CONNECTION_PLATFORMS.includes(platformKeyOf(e)),
    );
    const connected = needsMeta
      ? await this.meta.connectedPlatforms(profileType, profileId)
      : new Set<string>();
    return entries.map((entry) =>
      this.view(
        entry,
        isSocialAccountId(entry.socialAccountId)
          ? byId.get(entry.socialAccountId)
          : null,
        connected,
      ),
    );
  }

  private fetch(
    platformKey: string,
    profileType: SocialProfileType,
    profileId: string,
    declaredHandle: unknown,
  ): Promise<ObservationOutcome> {
    if (platformKey === "youtube") return this.youtube.observe(declaredHandle);
    if (platformKey === "instagram" || platformKey === "facebook") {
      return this.meta.observe(
        platformKey,
        profileType,
        profileId,
        declaredHandle,
      );
    }
    return Promise.resolve({ ok: false, reason: "unsupported_platform" });
  }

  private view(
    entry: Record<string, any>,
    doc: any,
    connectedPlatforms?: Set<string>,
  ): SocialAccountObservationView {
    return observationView(entry, doc, connectedPlatforms);
  }
}

/**
 * The admin view of one social account's observation, from its stored doc. Pure
 * — shared with the Stage 3D-1m evidence measurement (bulk-loaded docs).
 */
export function observationView(
  entry: Record<string, any>,
  doc: any,
  connectedPlatforms?: Set<string>,
): SocialAccountObservationView {
  const platformKey = platformKeyOf(entry);
  const requiresConnection = CONNECTION_PLATFORMS.includes(platformKey);
  return {
    socialAccountId: isSocialAccountId(entry.socialAccountId)
      ? entry.socialAccountId
      : null,
    platform: String(entry.platform ?? ""),
    platformKey,
    observable: (OBSERVABLE_PLATFORMS as readonly string[]).includes(
      platformKey,
    ),
    requiresConnection,
    // Unknown (null) when the caller didn't look it up, e.g. right after a Fetch.
    connected:
      requiresConnection && connectedPlatforms
        ? connectedPlatforms.has(platformKey)
        : null,
    observation: doc
      ? {
          status: doc.status,
          lastError: doc.lastError ?? null,
          lastAttemptAt: doc.lastAttemptAt ?? null,
          latest: doc.capturedAt
            ? {
                source: doc.source,
                externalAccountId: String(doc.externalAccountId ?? ""),
                observedHandle: String(doc.observedHandle ?? ""),
                observedFollowersCount: doc.observedFollowersCount ?? null,
                externalUrl: String(doc.externalUrl ?? ""),
                rawPlatformUpdatedAt: doc.rawPlatformUpdatedAt ?? null,
                capturedAt: doc.capturedAt,
              }
            : null,
        }
      : null,
  };
}
