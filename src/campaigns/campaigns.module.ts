import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  CampaignSchema,
  CampaignInviteSchema,
  BrandSchema,
  InfluencerSchema,
} from "../database/schemas/profile.schemas";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";
import { CampaignInvitesController } from "./campaign-invites.controller";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlansModule } from "../plans/plans.module";

@Module({
  imports: [
    PlansModule,
    MongooseModule.forFeature([
      { name: "Campaign", schema: CampaignSchema, collection: "campaigns" },
      {
        name: "CampaignInvite",
        schema: CampaignInviteSchema,
        collection: "campaign_invites",
      },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      {
        name: "Influencer",
        schema: InfluencerSchema,
        collection: "influencers",
      },
    ]),
  ],
  controllers: [CampaignsController, CampaignInvitesController],
  providers: [CampaignsService, CampaignInvitesService],
})
export class CampaignsModule {}
