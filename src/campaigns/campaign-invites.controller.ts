/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CampaignInvitesService } from "./campaign-invites.service";

@Controller("campaigns")
@UseGuards(JwtAuthGuard)
export class CampaignInvitesController {
  constructor(private readonly invitesService: CampaignInvitesService) {}

  // ── Brand: invite an influencer ──────────
  // POST /api/campaigns/:campaignId/invite
  @Post(":campaignId/invite")
  async inviteInfluencer(
    @Req() req: any,
    @Param("campaignId") campaignId: string,
    @Body() body: { influencerId: string },
  ) {
    return this.invitesService.createInvite(
      campaignId,
      body.influencerId,
      req.user.userId,
    );
  }

  // ── Influencer: respond to invite ────────
  // PATCH /api/campaigns/invites/:inviteId/respond
  @Patch("invites/:inviteId/respond")
  async respondToInvite(
    @Req() req: any,
    @Param("inviteId") inviteId: string,
    @Body() body: { accept: boolean },
  ) {
    return this.invitesService.respond(inviteId, req.user.userId, body.accept);
  }

  // ── Influencer: submit content ───────────
  // POST /api/campaigns/invites/:inviteId/submit
  @Post("invites/:inviteId/submit")
  async submitContent(
    @Req() req: any,
    @Param("inviteId") inviteId: string,
    @Body() body: { url: string; notes?: string },
  ) {
    return this.invitesService.submit(
      inviteId,
      req.user.userId,
      body.url,
      body.notes,
    );
  }

  // ── Brand: mark submission completed ─────
  // PATCH /api/campaigns/invites/:inviteId/complete
  @Patch("invites/:inviteId/complete")
  async markCompleted(@Req() req: any, @Param("inviteId") inviteId: string) {
    return this.invitesService.markCompleted(inviteId, req.user.userId);
  }

  // ── Brand: list invites for a campaign ───
  // GET /api/campaigns/:campaignId/invites
  @Get(":campaignId/invites")
  async getCampaignInvites(
    @Req() req: any,
    @Param("campaignId") campaignId: string,
  ) {
    return this.invitesService.getInvitesForCampaign(
      campaignId,
      req.user.userId,
    );
  }

  // ── Influencer: list my invites ──────────
  // GET /api/campaigns/my-invites?status=invited
  @Get("my-invites")
  async getMyInvites(@Req() req: any, @Query("status") status?: string) {
    return this.invitesService.getInvitesForInfluencer(req.user.userId, status);
  }
}
