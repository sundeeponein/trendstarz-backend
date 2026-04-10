import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('influencer')
  async getInfluencerDashboard(@Req() req: any) {
    return this.dashboardService.getInfluencerDashboard(req.user.userId);
  }

  @Get('brand')
  async getBrandDashboard(@Req() req: any) {
    return this.dashboardService.getBrandDashboard(req.user.userId);
  }
}
