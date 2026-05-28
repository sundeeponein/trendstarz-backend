import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { BrandsController } from "./brands.controller";
import { InfluencersController } from "./influencers.controller";
import { UsersService } from "./users.service";
import { CloudinaryService } from "../cloudinary.service";
import { MongooseModule } from "@nestjs/mongoose";
import {
  UserSchema,
  InfluencerSchema,
  BrandSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { UsageCounterSchema } from "../database/schemas/usage-counter.schema";
import { PlansModule } from "../plans/plans.module";
import { MonetizationModule } from "../monetization/monetization.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "User", schema: UserSchema, collection: "users" },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      {
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaigninvites",
      },
      {
        name: "UsageCounter",
        schema: UsageCounterSchema,
        collection: "usage_counters",
      },
    ]),
    PlansModule,
    MonetizationModule,
  ],
  controllers: [UsersController, BrandsController, InfluencersController],
  providers: [UsersService, CloudinaryService],
})
export class UsersModule {}
