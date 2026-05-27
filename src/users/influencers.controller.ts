import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DailyUsageGuard } from '../monetization/guards/daily-usage.guard';
import { UsageLimit } from '../monetization/decorators/usage-limit.decorator';

@Controller('users/influencers')
export class InfluencersController {
  constructor(
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
  ) {}

  @Get('search')
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit('search', 'dailySearchLimit')
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
