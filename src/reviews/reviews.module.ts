import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ReviewsController } from "./reviews.controller";
import { ReviewsService } from "./reviews.service";
import { ReviewSchema } from "../database/schemas/review.schema";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import {
  BrandSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { PlansModule } from "../plans/plans.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Review", schema: ReviewSchema, collection: "reviews" },
      {
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaigninvites",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
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
    PlansModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
