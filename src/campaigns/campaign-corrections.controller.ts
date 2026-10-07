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
import { RolesGuard } from "../auth/roles.guard";
import { CampaignCorrectionsService } from "./campaign-corrections.service";

/**
 * Admin campaign corrections (admin/subadmin only). Each action needs a reason
 * and re-checks the current state; GET lists what is allowed for each invite.
 */
@Controller("admin/campaign-corrections")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignCorrectionsController {
  constructor(private readonly service: CampaignCorrectionsService) {}

  private adminId(req: any): string {
    return String(req?.user?.userId || req?.user?.id || "admin");
  }

  @Get("campaigns/:campaignId")
  get(@Param("campaignId") campaignId: string) {
    return this.service.getCorrections(campaignId);
  }

  @Post("campaigns/:campaignId/extend-end-date")
  extendEndDate(
    @Param("campaignId") campaignId: string,
    @Body() body: { endDate?: string; reason?: string },
    @Req() req: any,
  ) {
    return this.service.extendEndDate(campaignId, body, this.adminId(req));
  }

  @Post("invites/:inviteId/restore")
  restore(
    @Param("inviteId") inviteId: string,
    @Body() body: { reason?: string; hostNotRefunded?: boolean },
    @Req() req: any,
  ) {
    return this.service.restoreParticipation(inviteId, body, this.adminId(req));
  }

  @Post("invites/:inviteId/extend-deadline")
  extendDeadline(
    @Param("inviteId") inviteId: string,
    @Body() body: { until?: string; reason?: string },
    @Req() req: any,
  ) {
    return this.service.extendSubmissionDeadline(
      inviteId,
      body,
      this.adminId(req),
    );
  }

  @Post("invites/:inviteId/submit-on-behalf")
  submitOnBehalf(
    @Param("inviteId") inviteId: string,
    @Body() body: { postUrl?: string; reason?: string },
    @Req() req: any,
  ) {
    return this.service.submitOnBehalf(inviteId, body, this.adminId(req));
  }

  @Post("invites/:inviteId/cancel")
  cancel(
    @Param("inviteId") inviteId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    return this.service.cancelParticipation(inviteId, body, this.adminId(req));
  }
}
