import { Module } from "@nestjs/common";
import { EvidenceQualityController } from "./evidence-quality.controller";
import { EvidenceQualityService } from "./evidence-quality.service";

/** Stage 3D-1m: read-only matching evidence-quality measurement (admin). */
@Module({
  controllers: [EvidenceQualityController],
  providers: [EvidenceQualityService],
})
export class MatchingEvidenceModule {}
