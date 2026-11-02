import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InviteViewsService } from "./invite-views.service";

@Controller("invite-views")
export class InviteViewsController {
  constructor(private readonly service: InviteViewsService) {}

  /** POST /invite-views/invite/:id — the recipient opened this invite */
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @UseGuards(JwtAuthGuard)
  @Post("invite/:id")
  invite(@Param("id") id: string, @Req() req: any) {
    return this.service.recordInviteView(id, String(req.user?.userId || ""));
  }

  /** POST /invite-views/campaign/:id — the host opened their campaign */
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @UseGuards(JwtAuthGuard)
  @Post("campaign/:id")
  campaign(@Param("id") id: string, @Req() req: any) {
    return this.service.recordCampaignView(id, String(req.user?.userId || ""));
  }

  /** GET /invite-views/admin/campaign/:id — who is being waited on, and have they seen it (admin only) */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/campaign/:id")
  adminCampaign(@Param("id") id: string) {
    return this.service.adminCampaignFollowUps(id);
  }
}
