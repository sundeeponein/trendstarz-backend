import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PhotographersController } from "./photographers.controller";
import { PhotographersService } from "./photographers.service";
import {
  PhotographerSchema,
  StateSchema,
  DistrictSchema,
  CampaignInviteSchema,
} from "../database/schemas/profile.schemas";
import { CloudinaryService } from "../cloudinary.service";
import { UsageCounterSchema } from "../database/schemas/usage-counter.schema";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { PlansModule } from "../plans/plans.module";

@Module({
  imports: [
    PlansModule,
    MongooseModule.forFeature([
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
      { name: "State", schema: StateSchema, collection: "states" },
      { name: "District", schema: DistrictSchema, collection: "districts" },
      { name: "ProfileFlag", schema: ProfileFlagSchema, collection: "profile_flags" },
    ]),
  ],
  controllers: [PhotographersController],
  providers: [PhotographersService, CloudinaryService],
  exports: [PhotographersService],
})
export class PhotographersModule {}
