import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CampaignsService } from "./campaigns.service";
import { CampaignInvitesService } from "./campaign-invites.service";

@Controller("campaigns")
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignInvitesService: CampaignInvitesService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const brandId = req.user?.userId;
    return this.campaignsService.create(brandId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findCampaigns(
    @Req() req: any,
    @Query("brandId") brandId?: string,
    @Query("status") status?: string,
  ) {
    if (brandId) {
      return this.campaignsService.findByBrandId(brandId);
    }
    const influencerId = req.user?.role === "influencer" ? req.user?.userId : undefined;
    return this.campaignsService.findPublic(status || "active", influencerId);
  }

  @Get("brand-name/:brandName")
  async findByBrandName(@Param("brandName") brandName: string) {
    return this.campaignsService.findByBrandName(brandName);
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    return this.campaignsService.findById(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  async update(@Param("id") id: string, @Req() req: any, @Body() body: any) {
    const brandId = req.user?.userId;
    return this.campaignsService.update(id, brandId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/invite-influencers")
  async inviteInfluencers(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { influencerIds: string[] },
  ) {
    const brandId = req.user?.userId;
    const influencerIds = Array.isArray(body?.influencerIds)
      ? body.influencerIds
      : [];
    if (!influencerIds.length) {
      return { success: true, invites: [], count: 0, failures: [] };
    }
    const invites: any[] = [];
    const failures: { influencerId: string; reason: string }[] = [];
    for (const influencerId of influencerIds) {
      try {
        const invite = await this.campaignInvitesService.create(brandId, {
          campaignId: id,
          influencerId,
        });
        invites.push(invite);
      } catch (err: any) {
        const reason =
          err?.response?.message || err?.message || "Failed to send invite";
        failures.push({ influencerId, reason });
      }
    }
    return {
      success: invites.length > 0,
      invites,
      count: invites.length,
      failures,
      requested: influencerIds.length,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/invite-photographers")
  async invitePhotographers(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { photographerIds: string[] },
  ) {
    const brandId = req.user?.userId;
    const photographerIds = Array.isArray(body?.photographerIds)
      ? body.photographerIds
      : [];
    if (!photographerIds.length) {
      return { success: true, invites: [], count: 0, failures: [] };
    }
    const invites: any[] = [];
    const failures: { photographerId: string; reason: string }[] = [];
    for (const photographerId of photographerIds) {
      try {
        const invite = await this.campaignInvitesService.create(brandId, {
          campaignId: id,
          influencerId: photographerId,
          recipientRole: "photographer",
        });
        invites.push(invite);
      } catch (err: any) {
        const reason =
          err?.response?.message || err?.message || "Failed to send invite";
        failures.push({ photographerId, reason });
      }
    }
    return {
      success: invites.length > 0,
      invites,
      count: invites.length,
      failures,
      requested: photographerIds.length,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: any) {
    const brandId = req.user?.userId;
    return this.campaignsService.remove(id, brandId);
  }
}
