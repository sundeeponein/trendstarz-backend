// import { SeedController } from './seed.controller';

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminListsController } from './admin-lists.controller';
import { CategoriesController, StatesController, DistrictsController, SocialMediaController, TiersController, LanguagesController } from './public-lists.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
// import mongoose from 'mongoose';
import { MongoLogger } from './database/mongo-logger';

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
} from './database/schemas/profile.schemas';

import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { UsersModule } from './users/users.module';
import { PaymentController } from './payment/payment.controller';
import { PaymentService } from './payment/payment.service';
import { StripeService } from './payment/stripe.service';


console.log("🚨 MONGODB_URI from Render =", process.env.MONGODB_URI);

// const mongoUri = process.env.MONGODB_URI;
// if (!mongoUri) {
//   throw new Error('MONGODB_URI environment variable is required');
// }

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // envFilePath: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env',
    }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),

    MongooseModule.forFeature([
      { name: 'Category', schema: CategorySchema, collection: 'categories' },
      { name: 'State', schema: StateSchema, collection: 'states' },
      { name: 'District', schema: DistrictSchema, collection: 'districts' },
      { name: 'SocialMedia', schema: SocialMediaSchema, collection: 'socialmedias' },
      { name: 'Language', schema: LanguageSchema, collection: 'languages' },
      { name: 'User', schema: UserSchema, collection: 'users' },
      { name: 'Influencer', schema: InfluencerSchema, collection: 'influencers' },
      { name: 'Brand', schema: BrandSchema, collection: 'brands' },
      { name: 'Tier', schema: TierSchema, collection: 'tiers' }, // <-- Add this line

    ]),
    UsersModule,
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
    // SeedController,
      PaymentController,
  ],

    providers: [AppService, AuthService, MongoLogger, PaymentService, StripeService],
})
export class AppModule {}