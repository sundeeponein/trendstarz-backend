import { Controller, Get, Query } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

type BrandDoc = { brandName: string; brandUsername?: string };

@Controller("brands")
export class BrandsController {
  constructor(
    @InjectModel("Brand") private readonly brandModel: Model<BrandDoc>,
  ) {}

  @Get("check-username-unique")
  async checkBrandUsernameUnique(
    @Query("username") username: string,
  ): Promise<boolean> {
    const normalized = (username || "").trim();
    if (!normalized) {
      return false;
    }

    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactCaseInsensitive = new RegExp(`^${escaped}$`, "i");
    const brand = await this.brandModel
      .findOne({
        $or: [
          { brandUsername: exactCaseInsensitive },
          { brandName: exactCaseInsensitive },
        ],
      })
      .select("_id")
      .lean();

    return !brand;
  }
}
