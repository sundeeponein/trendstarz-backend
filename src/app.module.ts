import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminListsController } from './admin-lists.controller';
import { CategoriesController, StatesController, SocialMediaController, TiersController, LanguagesController } from './public-lists.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { MongoLogger } from './database/mongo-logger';
import { 
  CategorySchema, 
  StateSchema, 
  SocialMediaSchema, 
  LanguageSchema, 
  UserSchema,
  InfluencerSchema,
  BrandSchema,
  TierSchema,
} from './database/schemas/profile.schemas';

import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { AdminUserTableController } from './admin/admin-user-table.controller';
import { UsersModule } from './users/users.module';
import { CloudinaryService } from './cloudinary.service';
import { HealthController } from './health.controller';

console.log('[DEBUG][MongooseModule] MONGODB_URI:', process.env.MONGODB_URI);
console.log('[DEBUG] process.cwd():', process.cwd());


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    MongooseModule.forFeature([
      { name: 'Category', schema: CategorySchema, collection: 'categories' },
      { name: 'State', schema: StateSchema, collection: 'states' },
      { name: 'SocialMedia', schema: SocialMediaSchema, collection: 'socialmedias' },
      { name: 'Language', schema: LanguageSchema, collection: 'languages' },
      { name: 'User', schema: UserSchema, collection: 'users' },
      { name: 'Influencer', schema: InfluencerSchema, collection: 'influencers' },
      { name: 'Brand', schema: BrandSchema, collection: 'brands' },
      { name: 'Tier', schema: TierSchema, collection: 'tiers' },
    ]),
    UsersModule,
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
    // PaymentController,
  ],
  providers: [AppService, AuthService, MongoLogger /*, PaymentService, StripeService*/],
})
export class AppModule {}