import { Module } from "@nestjs/common";
import { AdminGrowthController } from "./admin-growth.controller";
import { PublicShortlistController } from "./shortlist-requests.controller";
import { GrowthService } from "./growth.service";

/** Growth plan 2026-11-16: shortlist requests, scorecard, unanswered invites, Monday email. */
@Module({
  controllers: [PublicShortlistController, AdminGrowthController],
  providers: [GrowthService],
})
export class GrowthModule {}
