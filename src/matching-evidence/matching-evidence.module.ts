import { Module } from "@nestjs/common";
import { EvidenceQualityController } from "./evidence-quality.controller";
import { EvidenceQualityService } from "./evidence-quality.service";
import { ReactivationEmailController } from "./reactivation-email.controller";
import { ReactivationEmailService } from "./reactivation-email.service";

/** Stage 3D-1m: read-only matching evidence-quality measurement (admin); 3E: reactivation email. */
@Module({
  controllers: [EvidenceQualityController, ReactivationEmailController],
  providers: [EvidenceQualityService, ReactivationEmailService],
})
export class MatchingEvidenceModule {}
