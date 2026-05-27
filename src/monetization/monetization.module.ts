import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Reflector } from "@nestjs/core";
import { MonetizationController } from "./monetization.controller";
import { MonetizationService } from "./monetization.service";
import { PlanFeatureGuard } from "./guards/plan-feature.guard";
import { DailyUsageGuard } from "./guards/daily-usage.guard";
import { RazorpayService } from "../payment/razorpay.service";
import { PlansModule } from "../plans/plans.module";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { AppSettingsSchema, CampaignSchema } from "../database/schemas/profile.schemas";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CollaborationUnlockSchema } from "../database/schemas/collaboration-unlock.schema";
import { TransactionSchema } from "../database/schemas/transaction.schema";
import { UsageCounterSchema } from "../database/schemas/usage-counter.schema";
import { SocialProfileClickSchema } from "../database/schemas/social-profile-click.schema";

@Module({
  imports: [
    PlansModule,
    CampaignsModule,
    MongooseModule.forFeature([
      { name: "AppSettings", schema: AppSettingsSchema, collection: "appsettings" },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "CampaignInvite", schema: CampaignInviteSchema, collection: "campaigninvites" },
      { name: "Campaign", schema: CampaignSchema, collection: "campaigns" },
      { name: "CollaborationUnlock", schema: CollaborationUnlockSchema, collection: "collaboration_unlocks" },
      { name: "Transaction", schema: TransactionSchema, collection: "transactions" },
      { name: "UsageCounter", schema: UsageCounterSchema, collection: "usage_counters" },
      { name: "SocialProfileClick", schema: SocialProfileClickSchema, collection: "social_profile_clicks" },
    ]),
  ],
  controllers: [MonetizationController],
  providers: [
    Reflector,
    RazorpayService,
    MonetizationService,
    PlanFeatureGuard,
    DailyUsageGuard,
  ],
  exports: [MonetizationService, PlanFeatureGuard, DailyUsageGuard],
})
export class MonetizationModule {}
