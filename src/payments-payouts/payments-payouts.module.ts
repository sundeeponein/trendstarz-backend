import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  BrandSchema,
  AppSettingsSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { PaymentsPayoutsController } from "./payments-payouts.controller";
import { PaymentsPayoutsService } from "./payments-payouts.service";
import { PushModule } from "../push/push.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RazorpayService } from "../payment/razorpay.service";

@Module({
  imports: [
    MongooseModule.forFeature([
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
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      {
        name: "AppSettings",
        schema: AppSettingsSchema,
        collection: "appsettings",
      },
    ]),
    PushModule,
    NotificationsModule,
  ],
  controllers: [PaymentsPayoutsController],
  providers: [PaymentsPayoutsService, RazorpayService],
  exports: [PaymentsPayoutsService],
})
export class PaymentsPayoutsModule {}
