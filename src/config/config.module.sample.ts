// Sample NestJS module for config
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigController } from './config.controller.sample';
import { StateSchema, CategorySchema, LanguageSchema, TierSchema, SocialMediaSchema } from './config.model.sample';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'State', schema: StateSchema },
      { name: 'Category', schema: CategorySchema },
      { name: 'Language', schema: LanguageSchema },
      { name: 'Tier', schema: TierSchema },
      { name: 'SocialMedia', schema: SocialMediaSchema }
    ])
  ],
  controllers: [ConfigController],
  providers: []
})
export class ConfigModule {}
