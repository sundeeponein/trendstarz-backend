import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PhotographersController } from "./photographers.controller";
import { PhotographersService } from "./photographers.service";
import { PhotographerSchema } from "../database/schemas/profile.schemas";
import { CloudinaryService } from "../cloudinary.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
    ]),
  ],
  controllers: [PhotographersController],
  providers: [PhotographersService, CloudinaryService],
  exports: [PhotographersService],
})
export class PhotographersModule {}
