import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { OtpModule } from "./otp/otp.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AdminListsController } from "./admin-lists.controller";
import {
  CategoriesController,
  StatesController,
  DistrictsController,
  SocialMediaController,
  TiersController,
  LanguagesController,
} from "./public-lists.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModule } from "@nestjs/config";
import { MongoLogger } from "./database/mongo-logger";

import {
  CategorySchema,
  StateSchema,
  DistrictSchema,
  SocialMediaSchema,
  LanguageSchema,
  UserSchema,
  InfluencerSchema,
  BrandSchema,
  TierSchema,
  AppSettingsSchema,
  CampaignSchema,
} from "./database/schemas/profile.schemas";
import { PaymentSchema } from "./database/schemas/payment.schema";
import { CampaignInviteSchema } from "./database/schemas/campaign-invite.schema";
import { CampaignSubmissionSchema } from "./database/schemas/campaign-submission.schema";

import { AuthService } from "./auth/auth.service";
import { AuthController } from "./auth/auth.controller";
import { AdminUserTableController } from "./admin/admin-user-table.controller";
import { PaymentModule } from "./payment/payment.module";
import { UsersModule } from "./users/users.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { CloudinaryService } from "./cloudinary.service";
import { HealthController } from "./health.controller";
import { PlansModule } from "./plans/plans.module";
import { ReviewsModule } from "./reviews/reviews.module";
import { PaymentsPayoutsModule } from "./payments-payouts/payments-payouts.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    MongooseModule.forFeature([
      { name: "Category", schema: CategorySchema, collection: "categories" },
      { name: "State", schema: StateSchema, collection: "states" },
      { name: "District", schema: DistrictSchema, collection: "districts" },
      {
        name: "SocialMedia",
        schema: SocialMediaSchema,
        collection: "socialmedias",
      },
      { name: "Language", schema: LanguageSchema, collection: "languages" },
      { name: "User", schema: UserSchema, collection: "users" },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Tier", schema: TierSchema, collection: "tiers" },
      {
        name: "AppSettings",
        schema: AppSettingsSchema,
        collection: "appsettings",
      },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      {
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaigninvites",
      },
      {
        name: "CampaignSubmission",
        schema: CampaignSubmissionSchema,
        collection: "campaignsubmissions",
      },
      {
        name: "Campaign",
        schema: CampaignSchema,
        collection: "campaigns",
      },
    ]),
    UsersModule,
    CampaignsModule,
    OtpModule,
    PaymentModule,
    PlansModule,
    ReviewsModule,
    PaymentsPayoutsModule,
  ],
  controllers: [
    AppController,
    AdminListsController,
    CategoriesController,
    StatesController,
    DistrictsController,
    SocialMediaController,
    TiersController,
    LanguagesController,
    AuthController,
    HealthController,
    AdminUserTableController,
    DashboardController,
    // SeedController,
  ],
  providers: [
    AppService,
    AuthService,
    MongoLogger,
    CloudinaryService,
    DashboardService,
  ],
})
export class AppModule {}
