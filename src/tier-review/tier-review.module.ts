import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { NotificationsModule } from "../notifications/notifications.module";
import { PushModule } from "../push/push.module";
import { SocialAccountVerificationModule } from "../social-account-verification/social-account-verification.module";
import { CreatorObservationController } from "./creator-observation.controller";
import { CreatorRatesController } from "./creator-rates.controller";
import { TierAutoApplyService } from "./tier-auto-apply.service";
import { TierReviewController } from "./tier-review.controller";
import { TierReviewService } from "./tier-review.service";

/** Stage 3D-1b: tier review queue (admin, read-only) + nightly automatic YouTube tier correction. */
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
    ]),
    SocialAccountVerificationModule,
    NotificationsModule,
    PushModule,
  ],
  controllers: [
    TierReviewController,
    CreatorObservationController,
    CreatorRatesController,
  ],
  providers: [TierReviewService, TierAutoApplyService],
})
export class TierReviewModule {}
