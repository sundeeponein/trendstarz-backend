import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { MonetizationModule } from "../monetization/monetization.module";
import { CollaborationScoreModule } from "../collaboration-score/collaboration-score.module";
import { PaymentsPayoutsModule } from "../payments-payouts/payments-payouts.module";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookService } from "./razorpay-webhook.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "CampaignTransaction", schema: CampaignTransactionSchema, collection: "campaigntransactions" },
    ]),
    MonetizationModule,
    CollaborationScoreModule,
    PaymentsPayoutsModule,
  ],
  controllers: [RazorpayWebhookController],
  providers: [RazorpayWebhookService],
})
export class RazorpayWebhookModule {}
