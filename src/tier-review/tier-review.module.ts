import { Module } from "@nestjs/common";
import { TierReviewController } from "./tier-review.controller";
import { TierReviewService } from "./tier-review.service";

/** Stage 3D-1b: cross-profile tier review queue (admin, read-only). */
@Module({
  controllers: [TierReviewController],
  providers: [TierReviewService],
})
export class TierReviewModule {}
