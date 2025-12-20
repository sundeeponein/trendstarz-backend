 import { Controller, Post, Body, UseGuards, Patch, Param, Get, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import { UsersService } from './users.service';
import type { Request } from 'express';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async registerUser(@Body() body: any) {
    // Determine type by presence of brandName or other logic
    if (body.brandName) {
      // Brand registration
      return this.usersService.registerBrand(body);
    } else {
      // Influencer registration
      return this.usersService.registerInfluencer(body);
    }
  }


  @UseGuards(JwtAuthGuard)
  @Get('influencers')
  async getInfluencers() {
    return this.usersService.getInfluencers();
  }

  @UseGuards(JwtAuthGuard)
  @Get('brands')
  async getBrands() {
    return this.usersService.getBrands();
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/accept')
  async acceptUser(@Param('id') id: string) {
    return this.usersService.acceptUser(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/decline')
  async declineUser(@Param('id') id: string) {
    return this.usersService.declineUser(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/delete')
  async deleteUser(@Param('id') id: string) {
    return this.usersService.deleteUser(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/restore')
  async restoreUser(@Param('id') id: string) {
    return this.usersService.restoreUser(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/delete-permanent')
  async deletePermanently(@Param('id') id: string) {
    return this.usersService.deletePermanently(id);
  }

    @UseGuards(JwtAuthGuard)
    @Patch(':id/premium')
    async setPremium(
      @Param('id') id: string,
      @Body() body: { isPremium: boolean, premiumDuration?: string, type?: 'influencer' | 'brand' }
    ) {
      return this.usersService.setPremium(id, body.isPremium, body.premiumDuration, body.type);
    }

  @UseGuards(JwtAuthGuard)
  @Get('influencer-profile')
  async getInfluencerProfile(@Req() req: any) {
    console.log('[getInfluencerProfile] req.user:', req.user);
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    console.log('[getInfluencerProfileById] userId:', userId);
    return this.usersService.getInfluencerProfileById(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('influencer-profile')
  async updateInfluencerProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.updateInfluencerProfile(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('brand-profile')
  async getBrandProfile(@Req() req: any) {
  const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.getBrandProfileById(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('brand-profile')
  async updateBrandProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.updateBrandProfile(userId, body);
  }

}
