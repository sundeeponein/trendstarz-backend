import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PlatformEventSchema } from "../database/schemas/platform-event.schema";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { PaymentSchema } from "../database/schemas/payment.schema";
import {
  BrandSchema,
  CampaignSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { PlatformDataQualityController } from "./platform-data-quality.controller";
import { PlatformDataQualityService } from "./platform-data-quality.service";

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
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaigninvites",
      },
      {
        name: "CampaignTransaction",
        schema: CampaignTransactionSchema,
        collection: "campaigntransactions",
      },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
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
  controllers: [PlatformDataQualityController],
  providers: [PlatformDataQualityService],
})
export class PlatformDataQualityModule {}
