import { Module } from "@nestjs/common";
import { MatchingInputsModule } from "../matching-inputs/matching-inputs.module";
import { MatchingEligibilityController } from "./matching-eligibility.controller";
import { MatchingEligibilityService } from "./matching-eligibility.service";

/** Stage 3B-2: deterministic requirement eligibility over Stage 3B-1 inputs (no matcher/ranking). */
@Module({
  imports: [MatchingInputsModule],
  controllers: [MatchingEligibilityController],
  providers: [MatchingEligibilityService],
})
export class MatchingEligibilityModule {}
