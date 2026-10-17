import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { SocialAccountObservationModule } from "../social-account-observation/social-account-observation.module";
import { SocialAccountVerificationModule } from "../social-account-verification/social-account-verification.module";
import { MatchingInputsController } from "./matching-inputs.controller";
import { MatchingInputsService } from "./matching-inputs.service";

/** Stage 3B-1: normalized, read-only matching inputs (no matcher yet). */
@Module({
  imports: [
    SocialAccountVerificationModule,
    SocialAccountObservationModule,
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
      { name: "Campaign", schema: CampaignSchema, collection: "campaigns" },
    ]),
  ],
  controllers: [MatchingInputsController],
  providers: [MatchingInputsService],
  exports: [MatchingInputsService],
})
export class MatchingInputsModule {}
