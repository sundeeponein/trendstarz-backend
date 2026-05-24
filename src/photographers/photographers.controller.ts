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
import { Request } from "express";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";

function extractOptionalViewerId(req: any): string | null {
  try {
    const auth = req?.headers?.authorization;
    if (!auth) return null;
    const token = auth.split(" ")[1];
    if (!token) return null;
    const decoded: any = jwt.verify(token, getJwtSecret());
    return decoded?.userId || null;
  } catch {
    return null;
  }
}

@Controller("users/photographers")
export class PhotographersController {
  constructor(private readonly photographersService: PhotographersService) {}

  /** Public: search/list accepted photographers */
  @Get()
  async searchPhotographers(
    @Query()
    query: {
      skill?: string;
      location?: string;
      keyword?: string;
      limit?: string;
      viewerState?: string;
      viewerDistrict?: string;
      smartLocationPriority?: string;
    },
  ) {
    const smartPriority =
      String(query.smartLocationPriority || "").toLowerCase() === "1" ||
      String(query.smartLocationPriority || "").toLowerCase() === "true";
    return this.photographersService.searchPhotographers({
      skill: query.skill,
      location: query.location,
      keyword: query.keyword,
      limit: Number(query.limit) || 60,
      viewerState: query.viewerState,
      viewerDistrict: query.viewerDistrict,
      smartLocationPriority: smartPriority,
    });
  }

  /** Public: get single photographer by ID */
  @Get("username/:username")
  async getPhotographerByUsername(
    @Param("username") username: string,
    @Req() req: Request,
  ) {
    const viewerId = extractOptionalViewerId(req);
    return this.photographersService.getPhotographerByUsername(
      username,
      viewerId,
    );
  }

  /** Public: get single photographer by ID (legacy support) */
  @Get(":id")
  async getPhotographerById(@Param("id") id: string, @Req() req: Request) {
    const viewerId = extractOptionalViewerId(req);
    return this.photographersService.getPhotographerById(id, viewerId);
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
