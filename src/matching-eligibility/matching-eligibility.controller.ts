import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { EligibilityInvitesService } from "./eligibility-invites.service";
import { MatchingEligibilityService } from "./matching-eligibility.service";

/** Stage 3B-2 — deterministic requirement eligibility. Admin/subadmin only, read-only. */
@Controller("admin/matching")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MatchingEligibilityController {
  constructor(
    private readonly service: MatchingEligibilityService,
    private readonly invitesService: EligibilityInvitesService,
  ) {}

  /** Stage 3B-3 — every creator of the campaign's recipient type, grouped by status. */
  @Get("eligibility/:campaignId")
  campaignEligibility(
    @Param("campaignId") campaignId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.evaluateCampaign(campaignId, query);
  }

  /**
   * Stage 3B-4 — invite selected creators as the campaign owner (existing
   * invite flow, plan limits and notifications). Only PASS, not-yet-invited
   * creators are invited; the rest come back in `skipped` with a reason.
   */
  @Post("eligibility/:campaignId/invites")
  inviteEligible(
    @Param("campaignId") campaignId: string,
    @Body() body: { creatorIds?: unknown },
    @Req() req: any,
  ) {
    return this.invitesService.invite(
      campaignId,
      body?.creatorIds,
      String(req?.user?.userId || req?.user?.sub || ""),
    );
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
