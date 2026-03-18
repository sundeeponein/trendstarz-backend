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

@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

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
  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: any) {
    const brandId = req.user?.userId;
    return this.campaignsService.remove(id, brandId);
  }
}
