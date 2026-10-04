import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { MatchingInputsModule } from "../matching-inputs/matching-inputs.module";
import { EligibilityInvitesService } from "./eligibility-invites.service";
import { HostCampaignEligibilityController } from "./host-campaign-eligibility.controller";
import { MatchingEligibilityController } from "./matching-eligibility.controller";
import { MatchingEligibilityService } from "./matching-eligibility.service";

/** Stage 3B-2/3/4: deterministic requirement eligibility over Stage 3B-1 inputs, plus admin invites from it (no ranking). */
@Module({
  imports: [MatchingInputsModule, CampaignsModule],
  controllers: [
    MatchingEligibilityController,
    HostCampaignEligibilityController,
  ],
  providers: [MatchingEligibilityService, EligibilityInvitesService],
})
export class MatchingEligibilityModule {}
