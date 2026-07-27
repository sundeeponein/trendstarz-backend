import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  BrandSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { CollaborationAuditSchema } from "../database/schemas/collaboration-audit.schema";
import { CollaborationScoreSettingsSchema } from "../database/schemas/collaboration-score-settings.schema";
import { CollaborationSettingsAuditLogSchema } from "../database/schemas/collaboration-settings-audit-log.schema";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { TransactionSchema } from "../database/schemas/transaction.schema";
import { SocialOAuthConnectionSchema } from "../database/schemas/social-oauth-connection.schema";
import { ProfileVerificationModule } from "../profile-verification/profile-verification.module";
import { RazorpayService } from "../payment/razorpay.service";
import { MetaOAuthService } from "../meta-oauth/meta-oauth.service";
import { CollaborationScoreController } from "./collaboration-score.controller";
import { CollaborationScoreService } from "./collaboration-score.service";
import { CollaborationScoreRulesService } from "./collaboration-score-rules.service";
import { CollaborationScoreAiService } from "./collaboration-score-ai.service";
import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";
import { CollaborationScoreNightlyService } from "./collaboration-score-nightly.service";
import { SocialOAuthRefreshService } from "./social-oauth-refresh.service";
import { YoutubeCollectorService } from "./collectors/youtube-collector.service";
import { InstagramCollectorService } from "./collectors/instagram-collector.service";
import { FacebookCollectorService } from "./collectors/facebook-collector.service";
import { LinkedinCollectorService } from "./collectors/linkedin-collector.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "CollaborationAudit", schema: CollaborationAuditSchema, collection: "collaboration_audits" },
      {
        name: "CollaborationScoreSettings",
        schema: CollaborationScoreSettingsSchema,
        collection: "collaboration_score_settings",
      },
      {
        name: "CollaborationSettingsAuditLog",
        schema: CollaborationSettingsAuditLogSchema,
        collection: "collaboration_settings_audit_logs",
      },
      // Read-only in this module — never written back to. Quality/
      // verification fields on these collections stay owned exclusively by
      // ProfileVerificationService.
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Photographer", schema: PhotographerSchema, collection: "photographers" },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "Transaction", schema: TransactionSchema, collection: "transactions" },
      {
        name: "SocialOAuthConnection",
        schema: SocialOAuthConnectionSchema,
        collection: "social_oauth_connections",
      },
    ]),
    ProfileVerificationModule,
  ],
  controllers: [CollaborationScoreController],
  providers: [
    CollaborationScoreService,
    CollaborationScoreRulesService,
    CollaborationScoreAiService,
    CollaborationScoreSettingsService,
    YoutubeCollectorService,
    InstagramCollectorService,
    FacebookCollectorService,
    LinkedinCollectorService,
    CollaborationScoreNightlyService,
    SocialOAuthRefreshService,
    // Not exported by PaymentModule — re-declared here the same way
    // MonetizationModule does; RazorpayService has no injected deps, so a
    // second instance is harmless (see razorpay.service.ts).
    RazorpayService,
    MetaOAuthService,
  ],
  exports: [CollaborationScoreService],
})
export class CollaborationScoreModule {}
