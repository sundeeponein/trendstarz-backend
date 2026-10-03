import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MatchingEligibilityService } from "./matching-eligibility.service";

/** Stage 3B-2 — deterministic requirement eligibility. Admin/subadmin only, read-only. */
@Controller("admin/matching")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MatchingEligibilityController {
  constructor(private readonly service: MatchingEligibilityService) {}

  /** Stage 3B-3 — every creator of the campaign's recipient type, grouped by status. */
  @Get("eligibility/:campaignId")
  campaignEligibility(
    @Param("campaignId") campaignId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.evaluateCampaign(campaignId, query);
  }

  @Get("eligibility/:campaignId/:creatorType/:creatorId")
  eligibility(
    @Param("campaignId") campaignId: string,
    @Param("creatorType") creatorType: string,
    @Param("creatorId") creatorId: string,
  ) {
    return this.service.evaluate(campaignId, creatorType, creatorId);
  }
}
