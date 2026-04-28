import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  BrandSchema,
  InfluencerSchema,
  AppSettingsSchema,
} from "../database/schemas/profile.schemas";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { CampaignSubmissionSchema } from "../database/schemas/campaign-submission.schema";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";
import { CampaignInvitesController } from "./campaign-invites.controller";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlansModule } from "../plans/plans.module";
import { CloudinaryService } from "../cloudinary.service";

@Module({
  imports: [
    PlansModule,
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
      { name: "Brand", schema: BrandSchema, collection: "brands" },
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
  controllers: [CampaignsController, CampaignInvitesController],
  providers: [CampaignsService, CampaignInvitesService, CloudinaryService],
})
export class CampaignsModule {}
