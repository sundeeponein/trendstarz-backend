import { Module } from "@nestjs/common";
import { OtpModule } from "./otp/otp.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AdminListsController } from "./admin-lists.controller";
import {
  CategoriesController,
  StatesController,
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
  SocialMediaSchema,
  LanguageSchema,
  UserSchema,
  InfluencerSchema,
  BrandSchema,
  TierSchema,
  AppSettingsSchema,
} from "./database/schemas/profile.schemas";
import { PaymentSchema } from "./database/schemas/payment.schema";

import { AuthService } from "./auth/auth.service";
import { AuthController } from "./auth/auth.controller";
import { AdminUserTableController } from "./admin/admin-user-table.controller";
import { PaymentModule } from "./payment/payment.module";
import { UsersModule } from "./users/users.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { CloudinaryService } from "./cloudinary.service";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    MongooseModule.forFeature([
      { name: "Category", schema: CategorySchema, collection: "categories" },
      { name: "State", schema: StateSchema, collection: "states" },
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
      { name: "AppSettings", schema: AppSettingsSchema, collection: "appsettings" },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
    ]),
    UsersModule,
    CampaignsModule,
    OtpModule,
    PaymentModule,
  ],
  controllers: [
    AppController,
    AdminListsController,
    CategoriesController,
    StatesController,
    SocialMediaController,
    TiersController,
    LanguagesController,
    AuthController,
    HealthController,
    AdminUserTableController,
    // SeedController,
  ],
  providers: [
    AppService,
    AuthService,
    MongoLogger,
    CloudinaryService,
  ],
})
export class AppModule {}
