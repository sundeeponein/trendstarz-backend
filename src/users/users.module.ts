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
  CampaignSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { CollaborationAuditSchema } from "../database/schemas/collaboration-audit.schema";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { TransactionSchema } from "../database/schemas/transaction.schema";
import { UsageCounterSchema } from "../database/schemas/usage-counter.schema";
import { PlansModule } from "../plans/plans.module";
import { MonetizationModule } from "../monetization/monetization.module";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import { PhotographersModule } from "../photographers/photographers.module";

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
        name: "Campaign",
        schema: CampaignSchema,
        collection: "campaigns",
      },
      {
        name: "UsageCounter",
        schema: UsageCounterSchema,
        collection: "usage_counters",
      },
      {
        name: "ProfileFlag",
        schema: ProfileFlagSchema,
        collection: "profile_flags",
      },
      {
        name: "CollaborationAudit",
        schema: CollaborationAuditSchema,
        collection: "collaboration_audits",
      },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "Transaction", schema: TransactionSchema, collection: "transactions" },
    ]),
    PlansModule,
    MonetizationModule,
    PhotographersModule,
  ],
  controllers: [UsersController, BrandsController, InfluencersController],
  providers: [UsersService, CloudinaryService, FirebaseAdminService],
})
export class UsersModule {}
