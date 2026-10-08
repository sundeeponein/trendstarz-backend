import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { MetaOAuthService } from "../meta-oauth/meta-oauth.service";

/**
 * Meta long-lived tokens expire after ~60 days. Runs daily, refreshes
 * anything expiring within a week, and marks a connection revoked (rather
 * than repeatedly retrying a dead token on every future audit) if the
 * creator has revoked access on Meta's side or the refresh otherwise fails.
 * No admin-settings gate — this is plumbing, not a user-facing toggle, same
 * distinction as CollaborationScoreNightlyService vs this file.
 */
@Injectable()
export class SocialOAuthRefreshService {
  private readonly logger = new Logger(SocialOAuthRefreshService.name);
  private static readonly REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(
    @InjectModel("SocialOAuthConnection") private readonly connectionModel: Model<any>,
    private readonly metaOAuthService: MetaOAuthService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async refreshExpiringConnectionsCron(): Promise<void> {
    try {
      await this.refreshExpiringConnections();
    } catch (err: any) {
      this.logger.error(`Social OAuth token refresh cron failed: ${err?.message || err}`);
    }
  }

  async refreshExpiringConnections(): Promise<{ refreshed: number; revoked: number }> {
    const soon = new Date(Date.now() + SocialOAuthRefreshService.REFRESH_WINDOW_MS);
    const connections = await this.connectionModel
      .find({ revokedAt: null, longLivedTokenExpiresAt: { $lte: soon } })
      .select("+accessToken")
      .lean();

    let refreshed = 0;
    let revoked = 0;
    for (const conn of connections as any[]) {
      try {
        const result = await this.metaOAuthService.refreshLongLivedToken(conn.accessToken);
        await this.connectionModel.updateOne(
          { _id: conn._id },
          {
            $set: {
              accessToken: result.accessToken,
              longLivedTokenExpiresAt: result.expiresInSeconds
                ? new Date(Date.now() + result.expiresInSeconds * 1000)
                : null,
              lastRefreshedAt: new Date(),
            },
          },
        );
        refreshed++;
      } catch (err: any) {
        await this.connectionModel.updateOne({ _id: conn._id }, { $set: { revokedAt: new Date() } });
        revoked++;
        this.logger.warn(
          `Failed to refresh Meta token for connection ${conn._id}, marking revoked: ${err?.message || err}`,
        );
      }
    }
    if (connections.length) {
      this.logger.log(`Social OAuth token refresh: ${refreshed} refreshed, ${revoked} revoked.`);
    }
    return { refreshed, revoked };
  }
}
