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
  async findByBrand(@Query("brandId") brandId: string) {
    return this.campaignsService.findByBrandId(brandId);
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
      return { success: true, invites: [], count: 0 };
    }
    const invites = [];
    for (const influencerId of influencerIds) {
      const invite = await this.campaignInvitesService.create(brandId, {
        campaignId: id,
        influencerId,
      });
      invites.push(invite);
    }
    return { success: true, invites, count: invites.length };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: any) {
    const brandId = req.user?.userId;
    return this.campaignsService.remove(id, brandId);
  }
}
