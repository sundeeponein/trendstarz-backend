import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MarketplaceIntelligenceService } from "./marketplace-intelligence.service";

/**
 * Stage 3B-0 — Marketplace Intelligence Readiness. Admin-only, read-only:
 * what data exists for future matching, how complete and how consistent it is.
 * Same guards as the other admin routes (RolesGuard admits admin/subadmin only).
 */
@Controller("admin/marketplace")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketplaceIntelligenceController {
  constructor(private readonly service: MarketplaceIntelligenceService) {}

  @Get("intelligence-readiness")
  getReadiness() {
    return this.service.getReadinessReport();
  }
}
