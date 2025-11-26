import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminListsController } from './admin-lists.controller';
import { CategoriesController, StatesController, DistrictsController, SocialMediaController } from './public-lists.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
  ],
  controllers: [
    AppController,
    AdminListsController,
    CategoriesController,
    StatesController,
    DistrictsController,
    SocialMediaController
  ],
  providers: [AppService],
  
})
export class AppModule {}
