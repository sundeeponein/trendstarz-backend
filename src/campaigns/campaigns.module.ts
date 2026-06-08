import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  BrandSchema,
  InfluencerSchema,
  PhotographerSchema,
  AppSettingsSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CampaignSubmissionSchema } from "../database/schemas/campaign-submission.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { AnalyticsEventSchema } from "../database/schemas/analytics-event.schema";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";
import { CampaignInvitesController } from "./campaign-invites.controller";
import { CampaignInvitesService } from "./campaign-invites.service";
import { AnalyticsEventsController } from "./analytics-events.controller";
import { AnalyticsEventsService } from "./analytics-events.service";
import { PlansModule } from "../plans/plans.module";
import { CloudinaryService } from "../cloudinary.service";
import { PushModule } from "../push/push.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProfileVerificationModule } from "../profile-verification/profile-verification.module";

@Module({
  imports: [
    PlansModule,
    PushModule,
    NotificationsModule,
    ProfileVerificationModule,
    MongooseModule.forFeature([
      { name: "Campaign", schema: CampaignSchema, collection: "campaigns" },
      {
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaigninvites",
      },
      {
        name: "CampaignSubmission",
        schema: CampaignSubmissionSchema,
        collection: "campaignsubmissions",
      },
      {
        name: "CampaignTransaction",
        schema: CampaignTransactionSchema,
        collection: "campaigntransactions",
      },
      {
        name: "AnalyticsEvent",
        schema: AnalyticsEventSchema,
        collection: "analyticsevents",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      {
        name: "Photographer",
        schema: PhotographerSchema,
        collection: "photographers",
      },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
      {
        name: "AppSettings",
        schema: AppSettingsSchema,
        collection: "appsettings",
      },
    ]),
  ],
  controllers: [
    CampaignsController,
    CampaignInvitesController,
    AnalyticsEventsController,
  ],
  providers: [
    CampaignsService,
    CampaignInvitesService,
    AnalyticsEventsService,
    CloudinaryService,
  ],
  exports: [CampaignInvitesService],
})
export class CampaignsModule {}
