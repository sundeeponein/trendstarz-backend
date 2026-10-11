import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection, Model, Types } from "mongoose";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";
import { SocialProfileType } from "../database/schemas/social-account-verification.schema";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import { recordSocialEdit } from "../utils/admin-social-edit.util";
import { socialHandleKey } from "../utils/social-account.util";

/**
 * Keeps creators' social links working for hosts:
 *  1. YouTube: nightly, links learn the channel's permanent id (links survive renames);
 *     a rename found by that id updates the handle automatically, tells the creator and
 *     sends the account back to admin re-review ("Social changed" filter).
 *  2. Hosts can report a link that doesn't open → the creator is told, admin confirms
 *     (ownership back to pending → re-review) or dismisses.
 *  3. Every 90 days creators confirm their handles; 14 days unanswered → re-review.
 */
export const LINK_HEALTH = {
  confirmEveryDays: 90,
  confirmGraceDays: 14,
  renamedByName: "Auto (YouTube rename)",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PROFILE_URL: Record<string, string> = {
  Influencer: "/influencer-profile",
  Photographer: "/photographer-profile",
};
const ROLE: Record<string, "influencer" | "photographer"> = {
  Influencer: "influencer",
  Photographer: "photographer",
};

export function profileTypeForRole(role: unknown): SocialProfileType | null {
  const r = (typeof role === "string" ? role : "").toLowerCase();
  return r === "influencer"
    ? "Influencer"
    : r === "photographer"
      ? "Photographer"
      : null;
}

/** True when the creator should confirm their handles now (pure). */
export function handleConfirmDue(profile: any, now = new Date()): boolean {
  const accounts = (
    Array.isArray(profile?.socialMedia) ? profile.socialMedia : []
  ).filter((s: any) => String(s?.handle || "").trim());
  if (!accounts.length) return false;
  const base = profile?.socialConfirmedAt || profile?.createdAt;
  if (!base) return true;
  return (
    now.getTime() - new Date(base).getTime() >=
    LINK_HEALTH.confirmEveryDays * DAY_MS
  );
}

/** Prompted and not answered within the grace period → admin re-review (pure). */
export function handleConfirmOverdue(profile: any, now = new Date()): boolean {
  const prompted = profile?.socialConfirmPromptedAt
    ? new Date(profile.socialConfirmPromptedAt).getTime()
    : null;
  if (!prompted) return false;
  const confirmed = profile?.socialConfirmedAt
    ? new Date(profile.socialConfirmedAt).getTime()
    : 0;
  if (confirmed >= prompted) return false;
  return now.getTime() - prompted >= LINK_HEALTH.confirmGraceDays * DAY_MS;
}

/** Mongo filter for overdue handle confirmations (mirrors handleConfirmOverdue). */
export function overdueConfirmFilter(now = new Date()) {
  return {
    socialConfirmPromptedAt: {
      $ne: null,
      $lte: new Date(now.getTime() - LINK_HEALTH.confirmGraceDays * DAY_MS),
    },
    $or: [
      { socialConfirmedAt: null },
      { $expr: { $lt: ["$socialConfirmedAt", "$socialConfirmPromptedAt"] } },
    ],
  };
}

@Injectable()
export class SocialLinkHealthService {
  private readonly logger = new Logger(SocialLinkHealthService.name);
  private running = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly verification: SocialAccountVerificationService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  private modelFor(profileType: string): Model<any> | null {
    return profileType === "Influencer"
      ? this.influencerModel
      : profileType === "Photographer"
        ? this.photographerModel
        : null;
  }

  private notify(
    profileType: string,
    profileId: string,
    title: string,
    body: string,
  ) {
    const message = { title, body, url: PROFILE_URL[profileType] || "/" };
    this.notifications
      .createForUser({
        userId: profileId,
        userRole: ROLE[profileType] || "influencer",
        ...message,
      })
      .catch(() => undefined);
    this.push.sendToUser(profileId, message, "campaign").catch(() => undefined);
  }

  // ── 1. YouTube permanent links + rename sync ──────────────────────────────

  @Cron("15 3 * * *", { timeZone: "Asia/Kolkata", name: "youtubeLinkSync" })
  async nightly(): Promise<void> {
    try {
      const res = await this.syncYoutubeLinks();
      if (res.renamed || res.linked) {
        this.logger.log(
          `YouTube links: ${res.linked} linked by channel id, ${res.renamed} renamed`,
        );
      }
    } catch (err: any) {
      this.logger.error(`YouTube link sync failed: ${err?.message || err}`);
    }
  }

  async syncYoutubeLinks(): Promise<{ linked: number; renamed: number }> {
    if (this.running) return { linked: 0, renamed: 0 };
    this.running = true;
    let linked = 0;
    let renamed = 0;
    try {
      const observations = await this.connection
        .collection("social_account_observations")
        .find({
          platformKey: "youtube",
          status: "success",
          externalAccountId: { $regex: YT_CHANNEL_ID },
        })
        .toArray();
      for (const obs of observations) {
        const profileType = String(obs.profileType);
        const model = this.modelFor(profileType);
        if (!model) continue;
        const profileId = String(obs.profileId);
        const user: any = await model.findById(profileId);
        if (!user || user.isDeleted === true) continue;
        const list: any[] = Array.isArray(user.socialMedia)
          ? user.socialMedia
          : [];
        const index = list.findIndex(
          (e: any) => e?.socialAccountId === obs.socialAccountId,
        );
        if (index < 0) continue;
        const entry = list[index];
        const channelId = String(obs.externalAccountId);
        // Only for the handle that was checked — never attach a channel to another handle.
        const checkedHandle = socialHandleKey(obs.requestedHandle);
        if (!checkedHandle || checkedHandle !== socialHandleKey(entry.handle))
          continue;

        const newHandle = String(obs.handleChangedTo || "").trim();
        if (
          newHandle &&
          socialHandleKey(newHandle) !== socialHandleKey(entry.handle)
        ) {
          const oldHandle = String(entry.handle || "");
          recordSocialEdit(user, index, {
            handle: newHandle,
            platformAccountId: channelId,
            changedBy: "system",
            changedByName: LINK_HEALTH.renamedByName,
          });
          const saved = await user.save();
          // Handle changed → the verified ownership goes back to pending (re-review).
          await this.verification.reconcile(
            profileType as SocialProfileType,
            profileId,
            saved?.socialMedia ?? user.socialMedia,
          );
          renamed++;
          this.notify(
            profileType,
            profileId,
            "Your YouTube handle was updated",
            `Your YouTube channel is now @${newHandle} (was @${oldHandle}). We updated your TrendStarZ profile so hosts can open it. TrendStarZ will re-verify the account.`,
          );
          continue;
        }
        if (entry.platformAccountId !== channelId) {
          entry.platformAccountId = channelId;
          await user.save();
          linked++;
        }
      }
      return { linked, renamed };
    } finally {
      this.running = false;
    }
  }

  // ── 2. Broken-link reports ────────────────────────────────────────────────

  private async loadEntry(
    profileType: SocialProfileType,
    profileId: string,
    socialAccountId: string,
  ) {
    const model = this.modelFor(profileType);
    if (!model || !Types.ObjectId.isValid(profileId))
      throw new NotFoundException("Profile not found");
    const profile: any = await model
      .findById(profileId)
      .select("socialMedia isDeleted")
      .lean();
    if (!profile || profile.isDeleted === true)
      throw new NotFoundException("Profile not found");
    const entry = (profile.socialMedia || []).find(
      (e: any) => String(e?.socialAccountId) === String(socialAccountId),
    );
    if (!entry) throw new NotFoundException("Social account not found");
    return entry;
  }

  async reportBrokenLink(
    reporter: { userId: string; role: string },
    body: {
      profileType?: string;
      profileId?: string;
      socialAccountId?: string;
    },
  ) {
    const profileType =
      body?.profileType === "Photographer"
        ? "Photographer"
        : body?.profileType === "Influencer"
          ? "Influencer"
          : null;
    if (!profileType) throw new BadRequestException("Unknown profile type");
    const profileId = String(body?.profileId || "");
    if (!reporter.userId)
      throw new BadRequestException("Sign in to report a link");
    if (profileId === String(reporter.userId)) {
      throw new BadRequestException(
        "Update your own handle from your profile instead.",
      );
    }
    const entry = await this.loadEntry(
      profileType,
      profileId,
      String(body?.socialAccountId || ""),
    );
    const res = await this.verification.reportBrokenLink({
      profileType,
      profileId,
      entry,
      reporterId: reporter.userId,
      reporterRole: reporter.role,
    });
    if (res.firstOpen) {
      this.notify(
        profileType,
        profileId,
        `Your ${entry.platform || "social"} link isn't opening`,
        `Hosts reported that your ${entry.platform || "social"} link (@${entry.handle}) doesn't open. If you changed your username, update it on your TrendStarZ profile.`,
      );
    }
    return { success: true, status: res.status };
  }

  async resolveLinkReport(
    actor: any,
    body: {
      profileType?: string;
      profileId?: string;
      socialAccountId?: string;
      action?: string;
      note?: string;
    },
  ) {
    const profileType =
      body?.profileType === "Photographer"
        ? "Photographer"
        : body?.profileType === "Influencer"
          ? "Influencer"
          : null;
    if (!profileType) throw new BadRequestException("Unknown profile type");
    const action =
      body?.action === "confirm"
        ? "confirm"
        : body?.action === "dismiss"
          ? "dismiss"
          : null;
    if (!action) throw new BadRequestException("Choose confirm or dismiss.");
    const profileId = String(body?.profileId || "");
    const entry = await this.loadEntry(
      profileType,
      profileId,
      String(body?.socialAccountId || ""),
    );
    const res = await this.verification.resolveLinkReport(actor, {
      profileType,
      profileId,
      entry,
      action,
      note: body?.note,
    });
    if (action === "confirm") {
      this.notify(
        profileType,
        profileId,
        `Update your ${entry.platform || "social"} username`,
        `TrendStarZ checked: your ${entry.platform || "social"} link (@${entry.handle}) doesn't open. Update your username on your profile — the account will be verified again after that.`,
      );
    }
    return { success: true, ...res };
  }

  /** Admin: how many creators have a link hosts reported as not opening (per type). */
  async openReportCounts() {
    const [influencer, photographer] = await Promise.all([
      this.verification.profileIdsWithOpenLinkReports("Influencer"),
      this.verification.profileIdsWithOpenLinkReports("Photographer"),
    ]);
    return {
      success: true,
      data: { Influencer: influencer.size, Photographer: photographer.size },
    };
  }

  /** Which of a profile's links are reported as not opening (for hosts' "may be outdated"). */
  async linkStatus(profileType: string, profileId: string) {
    const type =
      profileType === "Photographer"
        ? "Photographer"
        : profileType === "Influencer"
          ? "Influencer"
          : null;
    if (!type) return { success: true, data: {} };
    return {
      success: true,
      data: await this.verification.linkReportsForProfile(
        type,
        String(profileId),
      ),
    };
  }

  // ── 3. 90-day handle confirmation ─────────────────────────────────────────

  /** The creator's own check: due? (marks when it was first shown, for the 14-day grace). */
  async confirmStatus(
    user: { userId: string; role: string },
    now = new Date(),
  ) {
    const profileType = profileTypeForRole(user.role);
    const model = profileType ? this.modelFor(profileType) : null;
    if (!model || !Types.ObjectId.isValid(String(user.userId)))
      return { due: false, accounts: [] };
    const profile: any = await model
      .findById(user.userId)
      .select("socialMedia socialConfirmedAt socialConfirmPromptedAt createdAt")
      .lean();
    if (!profile || !handleConfirmDue(profile, now))
      return { due: false, accounts: [] };
    const alreadyPrompted =
      profile.socialConfirmPromptedAt &&
      new Date(profile.socialConfirmPromptedAt).getTime() >
        new Date(profile.socialConfirmedAt || 0).getTime();
    if (!alreadyPrompted) {
      await model.updateOne(
        { _id: profile._id },
        { $set: { socialConfirmPromptedAt: now } },
      );
    }
    return {
      due: true,
      promptedAt: alreadyPrompted ? profile.socialConfirmPromptedAt : now,
      accounts: (profile.socialMedia || [])
        .filter((s: any) => String(s?.handle || "").trim())
        .map((s: any) => ({
          socialAccountId: s.socialAccountId,
          platform: s.platform,
          handle: s.handle,
          platformAccountId: s.platformAccountId || null,
        })),
    };
  }

  async confirmHandles(
    user: { userId: string; role: string },
    now = new Date(),
  ) {
    const profileType = profileTypeForRole(user.role);
    const model = profileType ? this.modelFor(profileType) : null;
    if (!model || !Types.ObjectId.isValid(String(user.userId))) {
      throw new BadRequestException(
        "Only creators confirm their social accounts.",
      );
    }
    await model.updateOne(
      { _id: user.userId },
      { $set: { socialConfirmedAt: now } },
    );
    return { success: true, confirmedAt: now };
  }

  /** Admin "Social changed" filter: creators who ignored the check for 14+ days. */
  async overdueConfirmIds(
    profileType: SocialProfileType,
    now = new Date(),
  ): Promise<string[]> {
    const model = this.modelFor(profileType);
    if (!model) return [];
    const rows: any[] = await model
      .find(overdueConfirmFilter(now))
      .select("_id")
      .lean();
    return rows.map((r) => String(r._id));
  }
}
