import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { EvidenceQualityService } from "./evidence-quality.service";

/**
 * Stage 3D-1m — matching evidence quality. Admin/subadmin only (RolesGuard),
 * read-only. One request-time asOf; nothing is stored.
 */
@Controller("admin/matching")
@UseGuards(JwtAuthGuard, RolesGuard)
export class EvidenceQualityController {
  constructor(private readonly service: EvidenceQualityService) {}

  @Get("evidence-quality")
  getEvidenceQuality() {
    return this.service.getReport();
  }
}
