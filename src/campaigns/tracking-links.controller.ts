import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { TrackingLinksService } from "./tracking-links.service";

@Controller()
export class TrackingLinksController {
  constructor(private readonly trackingLinksService: TrackingLinksService) {}

  @UseGuards(JwtAuthGuard)
  @Get("campaign-invites/:inviteId/tracking-link")
  async getMyTrackingLink(@Param("inviteId") inviteId: string, @Req() req: any) {
    const requesterId = req.user?.userId;
    return this.trackingLinksService.getOrCreateForInvite(inviteId, requesterId);
  }

  // Public — hit by the /r/:code redirect page. No auth: whoever clicked the shared link isn't a logged-in app user.
  @Get("tracking-links/resolve/:code")
  async resolve(@Param("code") code: string, @Req() req: any) {
    const ip =
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      "";
    const userAgent = req.headers["user-agent"] || "";
    const referrer = req.headers["referer"] || req.headers["referrer"] || "";
    const result = await this.trackingLinksService.resolveAndRecordClick(code, {
      ip,
      userAgent,
      referrer,
    });
    return result || { destinationUrl: null };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/tracking-links/analytics")
  async adminAnalytics(
    @Query("campaignId") campaignId?: string,
    @Query("hostId") hostId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.trackingLinksService.getAdminAnalytics({
      campaignId,
      hostId,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
