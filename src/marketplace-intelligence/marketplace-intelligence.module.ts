import { Module } from "@nestjs/common";
import { PlatformMetricsModule } from "../platform-metrics/platform-metrics.module";
import { MarketplaceIntelligenceController } from "./marketplace-intelligence.controller";
import { MarketplaceIntelligenceService } from "./marketplace-intelligence.service";

/** Stage 3B-0: read-only marketplace intelligence readiness audit (admin). */
@Module({
  imports: [PlatformMetricsModule],
  controllers: [MarketplaceIntelligenceController],
  providers: [MarketplaceIntelligenceService],
})
export class MarketplaceIntelligenceModule {}
