import { Module } from "@nestjs/common";
import { SocialAccountVerificationModule } from "../social-account-verification/social-account-verification.module";
import { AdminGrowthController } from "./admin-growth.controller";
import { PublicShortlistController } from "./shortlist-requests.controller";
import { GrowthService } from "./growth.service";

/** Growth plan 2026-11-16: shortlist requests, scorecard, unanswered invites, Monday email. */
@Module({
  imports: [SocialAccountVerificationModule],
  controllers: [PublicShortlistController, AdminGrowthController],
  providers: [GrowthService],
})
export class GrowthModule {}
