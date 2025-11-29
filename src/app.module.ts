import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminListsController } from './admin-lists.controller';
import { CategoriesController, StatesController, DistrictsController, SocialMediaController } from './public-lists.controller';
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
  UserSchema 
} from './database/schemas/profile.schemas';

import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';


console.log("🚨 MONGODB_URI from Render =", process.env.MONGODB_URI);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // envFilePath: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env',
    }),

    // ✅ FIXED MONGOOSE CONNECTION WITH PROPER TIMEOUTS
    MongooseModule.forRoot(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 5000,   // prevent 10s buffering timeout
      socketTimeoutMS: 45000,
      // retryWrites: true,
      // REQUIRED for SRV URLs (mongodb+srv://)
      directConnection: false,
    }),

    MongooseModule.forFeature([
      { name: 'Category', schema: CategorySchema, collection: 'categories' },
      { name: 'State', schema: StateSchema, collection: 'states' },
      { name: 'District', schema: DistrictSchema, collection: 'districts' },
      { name: 'SocialMedia', schema: SocialMediaSchema, collection: 'socialmedias' },
      { name: 'Language', schema: LanguageSchema, collection: 'languages' },
      { name: 'User', schema: UserSchema, collection: 'users' },
    ]),
  ],

  controllers: [
    AppController,
    AdminListsController,
    CategoriesController,
    StatesController,
    DistrictsController,
    SocialMediaController,
    AuthController,
  ],

  providers: [AppService, AuthService, MongoLogger],
})
export class AppModule {}

// 🔥 MONGOOSE CONNECTION LOGGING
// mongoose.connection.on('connected', () => {
//   console.log('🔥 MongoDB Connected Successfully!');
// });

// mongoose.connection.on('error', (err) => {
//   console.log('❌ MongoDB Connection Error:', err);
// });
