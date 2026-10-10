import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection, Model } from "mongoose";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import { recordSocialEdit } from "../utils/admin-social-edit.util";
import { tierRangeText } from "../utils/tier-ranges.util";
import { AUTO_TIER, autoTierDecision } from "./tier-auto-apply";

const PROFILE_URL: Record<string, string> = {
  Influencer: "/influencer-profile",
  Photographer: "/photographer-profile",
};

/**
 * Nightly (03:00 IST, after the 02:30 YouTube observation run): applies the
 * automatic tier correction (tier-auto-apply.ts) to every YouTube account that
 * passes all safeguards. Each correction is the same edit an admin makes in the
 * user pop-up (logged + the creator's "updated" notice), then an "auto" tier
 * verification on observed evidence, then a reminder to the creator.
 */
@Injectable()
export class TierAutoApplyService {
  private readonly logger = new Logger(TierAutoApplyService.name);
  private running = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly verification: SocialAccountVerificationService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Cron("0 3 * * *", { timeZone: "Asia/Kolkata", name: "youtubeTierAutoApply" })
  async nightly(): Promise<void> {
    try {
      const applied = await this.run(new Date());
      if (applied.length) {
        this.logger.log(
          `Auto tier: ${applied.length} YouTube tier(s) corrected`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Auto tier failed: ${err?.message || err}`);
    }
  }

  /** Applies every correction that passes the safeguards. Returns what was changed. */
  async run(now: Date): Promise<
    Array<{
      profileType: string;
      profileId: string;
      from: string;
      to: string;
      action: "change" | "verify";
    }>
  > {
    if (this.running) return [];
    this.running = true;
    const applied: Array<{
      profileType: string;
      profileId: string;
      from: string;
      to: string;
      action: "change" | "verify";
    }> = [];
    try {
      const observations = await this.connection
        .collection("social_account_observations")
        .find({
          platformKey: "youtube",
          source: "youtube",
          status: "success",
          observedFollowersCount: { $gt: 0 },
        })
        .toArray();
      for (const obs of observations) {
        const profileType = String(obs.profileType);
        const model =
          profileType === "Influencer"
            ? this.influencerModel
            : profileType === "Photographer"
              ? this.photographerModel
              : null;
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
        const entry = list[index]?.toObject
          ? list[index].toObject()
          : list[index];
        const verification = await this.connection
          .collection("social_account_verifications")
          .findOne({
            profileType,
            profileId,
            socialAccountId: obs.socialAccountId,
          });

        const result = autoTierDecision({
          entry,
          observation: obs,
          verification,
          now,
        });
        if (!result.apply) continue;
        const capturedText = result.capturedAt.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        });

        if (result.action === "verify") {
          // Already the right tier: verify it quietly (no edit, no notice to the creator).
          await this.verification.recordAutomaticTierDecision({
            profileType: profileType as any,
            profileId,
            entry,
            decidedByName: AUTO_TIER.decidedByName,
            note: `Matches YouTube: ${result.followers.toLocaleString("en-IN")} subscribers on ${capturedText} (${result.tier}).`,
            now,
            markAutoApplied: false,
          });
          applied.push({
            profileType,
            profileId,
            from: result.tier,
            to: result.tier,
            action: "verify",
          });
          continue;
        }

        recordSocialEdit(user, index, {
          tier: result.toTier,
          changedBy: "system",
          changedByName: AUTO_TIER.decidedByName,
        });
        const saved = await user.save();
        await this.verification.reconcile(
          profileType as any,
          profileId,
          saved?.socialMedia ?? user.socialMedia,
        );
        const updated = (saved?.socialMedia ?? user.socialMedia)[index];
        await this.verification.recordAutomaticTierDecision({
          profileType: profileType as any,
          profileId,
          entry: updated?.toObject ? updated.toObject() : updated,
          decidedByName: AUTO_TIER.decidedByName,
          note: `Changed from ${result.fromTier} to ${result.toTier}: YouTube showed ${result.followers.toLocaleString("en-IN")} subscribers on ${capturedText}.`,
          now,
        });
        applied.push({
          profileType,
          profileId,
          from: result.fromTier,
          to: result.toTier,
          action: "change",
        });

        const range = tierRangeText(result.toTier);
        const message = {
          title: `Your YouTube tier is now ${result.toTier}${range ? ` (${range})` : ""}`,
          body: `We checked your channel: ${result.followers.toLocaleString("en-IN")} subscribers on ${capturedText}, which is the ${result.toTier} tier${range ? ` (${range})` : ""}. Review your rates on your profile so they match your new tier.`,
          url: PROFILE_URL[profileType],
        };
        this.notifications
          .createForUser({
            userId: profileId,
            userRole:
              profileType === "Influencer" ? "influencer" : "photographer",
            ...message,
          })
          .catch(() => undefined);
        this.push
          .sendToUser(profileId, message, "campaign")
          .catch(() => undefined);
      }
      return applied;
    } finally {
      this.running = false;
    }
  }
}
