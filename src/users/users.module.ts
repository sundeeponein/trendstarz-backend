import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { BrandsController } from "./brands.controller";
import { InfluencersController } from './influencers.controller';
import { UsersService } from "./users.service";
import { CloudinaryService } from "../cloudinary.service";
import { MongooseModule } from "@nestjs/mongoose";
import {
  InfluencerSchema,
  BrandSchema,
} from "../database/schemas/profile.schemas";
import { PlansModule } from "../plans/plans.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
    ]),
    PlansModule,
  ],
  controllers: [UsersController, BrandsController, InfluencersController],
  providers: [UsersService, CloudinaryService],
})
export class UsersModule {}
