import { Controller, Get, UseGuards } from '@nestjs/common';
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
    return this.brandModel.find({}).lean().limit(100);
  }
}
