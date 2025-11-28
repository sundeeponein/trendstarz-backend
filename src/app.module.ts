import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminListsController } from './admin-lists.controller';
import { CategoriesController, StatesController, DistrictsController, SocialMediaController } from './public-lists.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { CategorySchema, StateSchema, DistrictSchema, SocialMediaSchema, LanguageSchema, UserSchema } from './database/schemas/profile.schemas';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    MongooseModule.forFeature([
      { name: 'Category', schema: CategorySchema },
      { name: 'State', schema: StateSchema },
      { name: 'District', schema: DistrictSchema },
      { name: 'SocialMedia', schema: SocialMediaSchema },
      { name: 'Language', schema: LanguageSchema },
      { name: 'User', schema: UserSchema },
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
  providers: [AppService, AuthService],
  
})
export class AppModule {}
