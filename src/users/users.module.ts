
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CloudinaryService } from '../cloudinary.service';
import { MongooseModule } from '@nestjs/mongoose';
import { InfluencerSchema, BrandSchema } from '../database/schemas/profile.schemas';


@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Influencer', schema: InfluencerSchema, collection: 'influencers' },
      { name: 'Brand', schema: BrandSchema, collection: 'brands' },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, CloudinaryService],
})
export class UsersModule {}
