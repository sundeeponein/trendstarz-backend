import { Controller, Get, Patch, Body, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

type BrandImageDoc = {
  brandLogo?: any[];
  products?: any[];
  promotionalPrice?: number;
  price?: number;
  save: () => Promise<unknown>;
};

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminUserTableController {
  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<BrandImageDoc>,
  ) {}


  @Get("influencers")
  async getInfluencers(@Param() params: any, @Body() body: any, @Body('status') status?: string, @Body('q') q?: string, @Body('category') category?: string) {
    // Support ?status=deleted for deleted users tab
    // Use req.query for status param
    const filter: any = {};
    // Use req.query for status param
    let statusParam = '';
    if (typeof body === 'object' && body && body.status) statusParam = body.status;
    if (typeof params === 'object' && params && params.status) statusParam = params.status;
    if (typeof status === 'string') statusParam = status;
    if (typeof q === 'string') filter.q = q;
    if (typeof category === 'string') filter.category = category;
    if (statusParam === 'deleted') {
      filter.isDeleted = true;
    } else {
      filter.isDeleted = { $ne: true };
    }
    return this.influencerModel.find(filter).lean().limit(100);
  }

  @Get("brands")
  async getBrands(@Param() params: any, @Body() body: any, @Body('status') status?: string, @Body('q') q?: string, @Body('category') category?: string) {
    // Support ?status=deleted for deleted users tab
    const filter: any = {};
    let statusParam = '';
    if (typeof body === 'object' && body && body.status) statusParam = body.status;
    if (typeof params === 'object' && params && params.status) statusParam = params.status;
    if (typeof status === 'string') statusParam = status;
    if (typeof q === 'string') filter.q = q;
    if (typeof category === 'string') filter.category = category;
    if (statusParam === 'deleted') {
      filter.isDeleted = true;
    } else {
      filter.isDeleted = { $ne: true };
    }
    // Always return brandLogo and products fields
    const brands = await this.brandModel.find(filter).lean().limit(100);
    brands.forEach((b) => {
      if (!b.brandLogo) b.brandLogo = [];
      if (!b.products) b.products = [];
      if (b.promotionalPrice === undefined && (b as any).price !== undefined) {
        b.promotionalPrice = (b as any).price;
      }
    });
    return brands;
  }

  // PATCH endpoint to directly update brandLogo and products for a brand
  @Patch("brands/:id/images")
  async patchBrandImages(
    @Param("id") id: string,
    @Body() body: { brandLogo?: any[]; products?: any[] },
  ) {
    console.log(
      "[ADMIN PATCH] patchBrandImages called for id:",
      id,
      "body:",
      JSON.stringify(body),
    );
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }
    if (body.brandLogo) {
      brand.brandLogo = body.brandLogo;
      console.log(
        "[ADMIN PATCH] Set brand.brandLogo to:",
        JSON.stringify(brand.brandLogo),
      );
    }
    if (body.products) {
      brand.products = body.products;
      console.log(
        "[ADMIN PATCH] Set brand.products to:",
        JSON.stringify(brand.products),
      );
    }
    await brand.save();
    return { message: "Brand images updated", brand };
  }
}
