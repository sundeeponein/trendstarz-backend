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

/**
 * Stage 3A-2: platform data observation. Internal-only — the admin endpoints
 * live on AdminUserTableController. Reuses the existing Meta OAuth client and
 * token storage (social_oauth_connections); adds no OAuth flow of its own.
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
  providers: [SocialAccountObservationService, YoutubeObserver, MetaObserver],
  exports: [SocialAccountObservationService],
})
export class SocialAccountObservationModule {}
