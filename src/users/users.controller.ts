import { Controller, Post, Body, UseGuards, Patch, Param, Get } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import { UsersService } from './users.service';

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
    async setPremium(@Param('id') id: string, @Body() body: { isPremium: boolean, premiumDuration?: string }) {
      return this.usersService.setPremium(id, body.isPremium, body.premiumDuration);
    }
}
