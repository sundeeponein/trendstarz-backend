import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PlatformDataQualityService } from "./platform-data-quality.service";

/**
 * Stage 2A — read-only data-quality / data-availability report over
 * platform_events. Admin-only (JwtAuthGuard + RolesGuard, same as other admin
 * routes). Returns ids and counts only — no contact details or free text.
 */
@Controller("admin/platform-events")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformDataQualityController {
  constructor(private readonly dataQuality: PlatformDataQualityService) {}

  @Get("data-quality")
  getDataQuality() {
    return this.dataQuality.getReport();
  }
}
