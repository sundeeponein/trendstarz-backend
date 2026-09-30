import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PlatformEventSchema } from "../database/schemas/platform-event.schema";
import {
  BrandSchema,
  CampaignSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { PlatformMetricsController } from "./platform-metrics.controller";
import { PlatformMetricsService } from "./platform-metrics.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "PlatformEvent",
        schema: PlatformEventSchema,
        collection: "platform_events",
      },
      { name: "Campaign", schema: CampaignSchema, collection: "campaigns" },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
    ]),
  ],
  controllers: [PlatformMetricsController],
  providers: [PlatformMetricsService],
})
export class PlatformMetricsModule {}
