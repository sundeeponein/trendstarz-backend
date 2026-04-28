import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  BrandSchema,
  AppSettingsSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { PaymentsPayoutsController } from "./payments-payouts.controller";
import { PaymentsPayoutsService } from "./payments-payouts.service";

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
      {
        name: "AppSettings",
        schema: AppSettingsSchema,
        collection: "appsettings",
      },
    ]),
  ],
  controllers: [PaymentsPayoutsController],
  providers: [PaymentsPayoutsService],
  exports: [PaymentsPayoutsService],
})
export class PaymentsPayoutsModule {}
