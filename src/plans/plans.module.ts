import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PlansService } from "./plans.service";
import { PlansController } from "./plans.controller";
import { PlansConfigController } from "./plans-config.controller";
import { ImageCleanupService } from "./image-cleanup.service";
import {
  PlanSchema,
  SubscriptionSchema,
} from "../database/schemas/plan.schema";
import {
  InfluencerSchema,
  BrandSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { CloudinaryService } from "../cloudinary.service";

@Module({
  imports: [
    // The scheduler is registered once, in AppModule. Registering it here as
    // well made EVERY @Cron job in the app run twice.
    MongooseModule.forFeature([
      { name: "Plan", schema: PlanSchema, collection: "plans" },
      {
        name: "Subscription",
        schema: SubscriptionSchema,
        collection: "subscriptions",
      },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
    ]),
  ],
  controllers: [PlansController, PlansConfigController],
  providers: [PlansService, ImageCleanupService, CloudinaryService],
  exports: [PlansService],
})
export class PlansModule {}
