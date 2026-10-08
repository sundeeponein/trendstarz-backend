import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { MatchingEligibilityService } from "./matching-eligibility.service";

/**
 * Stage 3B-4 — campaign owner's view of creator eligibility (read-only).
 * The service allows only the owner or an admin.
 */
@Controller("campaigns")
@UseGuards(JwtAuthGuard)
export class HostCampaignEligibilityController {
  constructor(private readonly service: MatchingEligibilityService) {}

  /**
   * Campaign form, invite step: the same labels for requirements that are not
   * saved yet (create mode has no campaign id). Read-only.
   */
  @Post("creator-eligibility/preview")
  previewCreatorEligibility(
    @Body() body: Record<string, unknown>,
    @Req() req: any,
  ) {
    return this.service.previewForHost(body, { role: req?.user?.role });
  }

  @Get(":id/creator-eligibility")
  creatorEligibility(@Param("id") id: string, @Req() req: any) {
    return this.service.forHost(id, {
      userId: String(req?.user?.userId || req?.user?.sub || ""),
      role: req?.user?.role,
    });
  }
}
