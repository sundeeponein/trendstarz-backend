import { Controller, Get, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminUserTableController {
  constructor(
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
    @InjectModel('Brand') private readonly brandModel: Model<any>
  ) {}

  @Get('influencers')
  async getInfluencers() {
    return this.influencerModel.find({}).lean().limit(100);
  }

  @Get('brands')
  async getBrands() {
    // Always return brandLogo and products fields
    const brands = await this.brandModel.find({}).lean().limit(100);
    brands.forEach(b => {
      if (!b.brandLogo) b.brandLogo = [];
      if (!b.products) b.products = [];
    });
    return brands;
  }

  // PATCH endpoint to directly update brandLogo and products for a brand
  @Patch('brands/:id/images')
  async patchBrandImages(@Param('id') id: string, @Body() body: { brandLogo?: any[]; products?: any[] }) {
    console.log('[ADMIN PATCH] patchBrandImages called for id:', id, 'body:', JSON.stringify(body));
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: 'Brand not found', id };
    }
    if (body.brandLogo) {
      brand.brandLogo = body.brandLogo;
      console.log('[ADMIN PATCH] Set brand.brandLogo to:', JSON.stringify(brand.brandLogo));
    }
    if (body.products) {
      brand.products = body.products;
      console.log('[ADMIN PATCH] Set brand.products to:', JSON.stringify(brand.products));
    }
    await brand.save();
    return { message: 'Brand images updated', brand };
  }
}
