import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PhotographersController } from "./photographers.controller";
import { PhotographersService } from "./photographers.service";
import {
  PhotographerSchema,
  StateSchema,
  DistrictSchema,
} from "../database/schemas/profile.schemas";
import { CloudinaryService } from "../cloudinary.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      { name: "State", schema: StateSchema, collection: "states" },
      { name: "District", schema: DistrictSchema, collection: "districts" },
    ]),
  ],
  controllers: [PhotographersController],
  providers: [PhotographersService, CloudinaryService],
  exports: [PhotographersService],
})
export class PhotographersModule {}
