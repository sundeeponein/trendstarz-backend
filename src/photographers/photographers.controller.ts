import {
  Controller,
  Get,
  Patch,
  Body,
  Req,
  Query,
  Param,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PhotographersService } from "./photographers.service";

@Controller("users/photographers")
export class PhotographersController {
  constructor(private readonly photographersService: PhotographersService) {}

  /** Public: search/list accepted photographers */
  @Get()
  async searchPhotographers(
    @Query() query: { skill?: string; location?: string; keyword?: string; limit?: string },
  ) {
    return this.photographersService.searchPhotographers({
      skill: query.skill,
      location: query.location,
      keyword: query.keyword,
      limit: Number(query.limit) || 60,
    });
  }

  /** Public: get single photographer by ID */
  @Get(":id")
  async getPhotographerById(@Param("id") id: string) {
    return this.photographersService.getPhotographerById(id);
  }

  /** Authenticated: get own profile */
  @Get("me/profile")
  @UseGuards(JwtAuthGuard)
  async getMyProfile(@Req() req: any) {
    return this.photographersService.getProfile(req.user.userId);
  }

  /** Authenticated: update own profile */
  @Patch("me/profile")
  @UseGuards(JwtAuthGuard)
  async updateMyProfile(@Req() req: any, @Body() body: any) {
    return this.photographersService.updateProfile(req.user.userId, body);
  }
}
