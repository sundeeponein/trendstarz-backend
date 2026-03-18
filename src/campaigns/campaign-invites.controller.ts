import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CampaignInvitesService } from "./campaign-invites.service";

@Controller("campaign-invites")
export class CampaignInvitesController {
  constructor(private readonly invitesService: CampaignInvitesService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const brandId = req.user?.userId;
    return this.invitesService.create(brandId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get("campaign/:campaignId")
  async findByCampaign(@Param("campaignId") campaignId: string) {
    return this.invitesService.findByCampaign(campaignId);
  }

  @UseGuards(JwtAuthGuard)
  @Get("influencer")
  async findByInfluencer(@Req() req: any) {
    const influencerId = req.user?.userId;
    return this.invitesService.findByInfluencer(influencerId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/respond")
  async respond(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { status: "accepted" | "declined" },
  ) {
    const influencerId = req.user?.userId;
    return this.invitesService.respond(id, influencerId, body.status);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/analytics")
  async submitAnalytics(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reach?: number; engagement?: number; clicks?: number },
  ) {
    const influencerId = req.user?.userId;
    return this.invitesService.submitAnalytics(id, influencerId, body);
  }
}
