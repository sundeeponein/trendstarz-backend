import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Controller('users/influencers')
export class InfluencersController {
  constructor(
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
  ) {}

  @Get('search')
  @UseGuards(JwtAuthGuard)
  async searchInfluencers(@Query() query: any) {
    const filter: any = { status: 'accepted' };
    if (query.category) filter.categories = query.category;
    if (query.state) filter['location.state'] = query.state;
    const docs = await this.influencerModel.find(filter)
      .select('name categories location profileImages isPremium premiumEnd')
      .lean();
    const now = new Date();
    return (docs || []).map((doc: any) => ({
      ...doc,
      isPremium:
        !!doc?.isPremium &&
        (!doc?.premiumEnd || new Date(doc.premiumEnd) >= now),
    }));
  }
}
