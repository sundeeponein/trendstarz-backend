import { Module } from "@nestjs/common";
import { SocialAccountObservationModule } from "../social-account-observation/social-account-observation.module";
import { SocialAccountVerificationModule } from "../social-account-verification/social-account-verification.module";
import { SocialAccountComparisonService } from "./social-account-comparison.service";

/** Stage 3A-3: admin-only, read-only DECLARED vs VERIFIED vs OBSERVED comparison. */
@Module({
  imports: [SocialAccountVerificationModule, SocialAccountObservationModule],
  providers: [SocialAccountComparisonService],
  exports: [SocialAccountComparisonService],
})
export class SocialAccountComparisonModule {}
