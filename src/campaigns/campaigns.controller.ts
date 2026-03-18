import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Document, Types } from "mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@Controller("campaigns")
export class CampaignsController {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<Document>,
  ) {}

  // ── Helpers ──────────────────────────────
  private async assertOwnership(campaignId: string, userId: string) {
    const campaign = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String((campaign as any).brandId) !== String(userId)) {
      throw new ForbiddenException("You do not own this campaign");
    }
    return campaign;
  }

  // ── Public reads (brand-name lookup used by public profile) ──
  // GET /api/campaigns/brand-name/:brandName
  @Get("brand-name/:brandName")
  async getCampaignsByBrandName(@Param("brandName") brandName: string) {
    const BrandModel = this.campaignModel.db.model("Brand");
    const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const brand = (await BrandModel.findOne({
      $or: [
        { brandName: new RegExp(`^${escaped}$`, "i") },
        { brandUsername: new RegExp(`^${escaped}$`, "i") },
      ],
    })
      .select("_id")
      .lean()) as { _id: Types.ObjectId } | null;
    if (!brand) return [];
    return this.campaignModel
      .find({ brandId: brand._id })
      .sort({ createdAt: -1 })
      .lean();
  }

  // ── Authenticated endpoints ──────────────
  // GET /api/campaigns?brandId=xxx
  @UseGuards(JwtAuthGuard)
  @Get()
  async getCampaigns(@Query("brandId") brandId: string) {
    if (!brandId) return [];
    return this.campaignModel
      .find({ brandId: new Types.ObjectId(brandId) })
      .sort({ createdAt: -1 })
      .lean();
  }

  // GET /api/campaigns/:id
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  async getCampaignById(@Param("id") id: string) {
    return this.campaignModel.findById(id).lean();
  }

  // POST /api/campaigns
  @UseGuards(JwtAuthGuard)
  @Post()
  async createCampaign(@Req() req: any, @Body() body: Record<string, unknown>) {
    // Force brandId to the authenticated user
    const userId = req.user?.userId;
    return this.campaignModel.create({ ...body, brandId: userId });
  }

  // PATCH /api/campaigns/:id
  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  async updateCampaign(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.assertOwnership(id, req.user?.userId);
    return this.campaignModel.findByIdAndUpdate(id, body, { new: true }).lean();
  }

  // DELETE /api/campaigns/:id
  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  async deleteCampaign(@Req() req: any, @Param("id") id: string) {
    await this.assertOwnership(id, req.user?.userId);
    await this.campaignModel.findByIdAndDelete(id);
    return { deleted: true };
  }
}
