import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Document, Types } from "mongoose";

@Controller("campaigns")
export class CampaignsController {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<Document>,
  ) {}

  // GET /api/campaigns?brandId=xxx
  @Get()
  async getCampaigns(@Query("brandId") brandId: string) {
    if (!brandId) return [];
    return this.campaignModel
      .find({ brandId: new Types.ObjectId(brandId) })
      .sort({ createdAt: -1 })
      .lean();
  }

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

  // GET /api/campaigns/:id
  @Get(":id")
  async getCampaignById(@Param("id") id: string) {
    return this.campaignModel.findById(id).lean();
  }

  // POST /api/campaigns
  @Post()
  async createCampaign(@Body() body: Record<string, unknown>) {
    return this.campaignModel.create(body);
  }

  // PATCH /api/campaigns/:id
  @Patch(":id")
  async updateCampaign(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.campaignModel.findByIdAndUpdate(id, body, { new: true }).lean();
  }

  // DELETE /api/campaigns/:id
  @Delete(":id")
  async deleteCampaign(@Param("id") id: string) {
    await this.campaignModel.findByIdAndDelete(id);
    return { deleted: true };
  }
}
