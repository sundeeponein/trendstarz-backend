import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  SocialAccountObservationHistorySchema,
  SocialAccountObservationSchema,
} from "../database/schemas/social-account-observation.schema";
import { SocialOAuthConnectionSchema } from "../database/schemas/social-oauth-connection.schema";
import { MetaOAuthModule } from "../meta-oauth/meta-oauth.module";
import { MetaObserver, YoutubeObserver } from "./platform-observers";
import { SocialAccountObservationService } from "./social-account-observation.service";
import { YoutubeObservationScheduleController } from "./youtube-observation-schedule.controller";
import { YoutubeObservationSchedulerService } from "./youtube-observation-scheduler.service";

/**
 * Stage 3A-2: platform data observation. The per-account admin endpoints live
 * on AdminUserTableController. Reuses the existing Meta OAuth client and token
 * storage (social_oauth_connections); adds no OAuth flow of its own.
 * Stage 3D-1a: scheduled YouTube observation + statistics retention, with a
 * read-only admin status endpoint.
 */
@Module({
  imports: [
    MetaOAuthModule,
    MongooseModule.forFeature([
      {
        name: "SocialAccountObservation",
        schema: SocialAccountObservationSchema,
        collection: "social_account_observations",
      },
      {
        name: "SocialAccountObservationHistory",
        schema: SocialAccountObservationHistorySchema,
        collection: "social_account_observation_history",
      },
      {
        name: "SocialOAuthConnection",
        schema: SocialOAuthConnectionSchema,
        collection: "social_oauth_connections",
      },
    ]),
  ],
  controllers: [YoutubeObservationScheduleController],
  providers: [
    SocialAccountObservationService,
    YoutubeObserver,
    MetaObserver,
    YoutubeObservationSchedulerService,
  ],
  exports: [SocialAccountObservationService],
})
export class SocialAccountObservationModule {}
