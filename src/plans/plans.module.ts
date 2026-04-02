import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ScheduleModule } from "@nestjs/schedule";
import { PlansService } from "./plans.service";
import { PlansController } from "./plans.controller";
import { ImageCleanupService } from "./image-cleanup.service";
import { PlanSchema, SubscriptionSchema } from "../database/schemas/plan.schema";
import { InfluencerSchema, BrandSchema } from "../database/schemas/profile.schemas";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: "Plan", schema: PlanSchema, collection: "plans" },
      { name: "Subscription", schema: SubscriptionSchema, collection: "subscriptions" },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
    ]),
  ],
  controllers: [PlansController],
  providers: [PlansService, ImageCleanupService],
  exports: [PlansService],
})
export class PlansModule {}
