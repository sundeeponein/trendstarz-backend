import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PhotographersController } from "./photographers.controller";
import { PhotographersService } from "./photographers.service";
import {
  PhotographerSchema,
  InfluencerSchema,
  BrandSchema,
  UserSchema,
  StateSchema,
  DistrictSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CloudinaryService } from "../cloudinary.service";
import { UsageCounterSchema } from "../database/schemas/usage-counter.schema";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { CollaborationAuditSchema } from "../database/schemas/collaboration-audit.schema";
import { PlansModule } from "../plans/plans.module";
import { SocialAccountVerificationModule } from "../social-account-verification/social-account-verification.module";

@Module({
  imports: [
    PlansModule,
    SocialAccountVerificationModule,
    MongooseModule.forFeature([
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "User", schema: UserSchema, collection: "users" },
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
      { name: "CollaborationAudit", schema: CollaborationAuditSchema, collection: "collaboration_audits" },
    ]),
  ],
  controllers: [PhotographersController],
  providers: [PhotographersService, CloudinaryService],
  exports: [PhotographersService],
})
export class PhotographersModule {}
