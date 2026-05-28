import {
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Body,
  Req,
  Query,
  Param,
  UseGuards,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PhotographersService } from "./photographers.service";
import { Request } from "express";
import { Model } from "mongoose";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { PlansService } from "../plans/plans.service";

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

function extractOptionalViewerContext(req: any): { userId: string; role: string } | null {
  try {
    const auth = req?.headers?.authorization;
    if (!auth) return null;
    const token = auth.split(" ")[1];
    if (!token) return null;
    const decoded: any = jwt.verify(token, getJwtSecret());
    const userId = String(decoded?.userId || "").trim();
    const role = String(decoded?.role || "").trim().toLowerCase();
    if (!userId || !role) return null;
    return { userId, role };
  } catch {
    return null;
  }
}

function toDayKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

@Controller("users/photographers")
export class PhotographersController {
  constructor(
    private readonly photographersService: PhotographersService,
    private readonly plansService: PlansService,
    @InjectModel("UsageCounter") private readonly usageModel: Model<any>,
  ) {}

  private async consumeDailySearchQuotaIfAuthenticated(req?: Request): Promise<{
    used: number;
    remaining: number;
    limit: number;
    day: string;
  } | null> {
    const viewer = extractOptionalViewerContext(req);
    if (!viewer) return null;

    const caps = await this.plansService.getUserPlanCapabilities(viewer.userId);
    const limitEntry = (caps?.limits || []).find(
      (l: any) => String(l?.key || "") === "dailySearchLimit",
    );
    const maxLimit = Number(limitEntry?.value ?? 0);

    if (maxLimit <= 0) {
      throw new ForbiddenException(
        "Daily limit reached. Upgrade your plan for higher limits.",
      );
    }

    const day = toDayKey();
    const doc = await this.usageModel.findOneAndUpdate(
      {
        userId: viewer.userId,
        userRole: viewer.role,
        usageType: "search",
        day,
      },
      {
        $setOnInsert: {
          userId: viewer.userId,
          userRole: viewer.role,
          usageType: "search",
          day,
          used: 0,
        },
      },
      { new: true, upsert: true },
    );

    if ((doc?.used || 0) >= maxLimit) {
      throw new ForbiddenException(
        "You have exhausted today's usage limit. Please upgrade your plan.",
      );
    }

    const updated = await this.usageModel.findByIdAndUpdate(doc._id, {
      $inc: { used: 1 },
      $set: {
        limit: maxLimit,
        remaining: Math.max(maxLimit - ((doc?.used || 0) + 1), 0),
      },
    }, { new: true });

    return {
      used: Number(updated?.used || 0),
      remaining: Number(updated?.remaining || 0),
      limit: maxLimit,
      day,
    };
  }

  private async consumeDailyProfileViewQuotaIfAuthenticated(req?: Request): Promise<void> {
    const viewer = extractOptionalViewerContext(req);
    if (!viewer) return;

    const caps = await this.plansService.getUserPlanCapabilities(viewer.userId);
    const limitEntry = (caps?.limits || []).find(
      (l: any) => String(l?.key || "") === "dailyProfileViewLimit",
    );
    const maxLimit = Number(limitEntry?.value ?? 0);

    if (maxLimit <= 0) {
      throw new ForbiddenException(
        "Daily limit reached. Upgrade your plan for higher limits.",
      );
    }

    const day = toDayKey();
    const doc = await this.usageModel.findOneAndUpdate(
      {
        userId: viewer.userId,
        userRole: viewer.role,
        usageType: "profile_view",
        day,
      },
      {
        $setOnInsert: {
          userId: viewer.userId,
          userRole: viewer.role,
          usageType: "profile_view",
          day,
          used: 0,
        },
      },
      { new: true, upsert: true },
    );

    if ((doc?.used || 0) >= maxLimit) {
      throw new ForbiddenException(
        "You have exhausted today's usage limit. Please upgrade your plan.",
      );
    }

    await this.usageModel.findByIdAndUpdate(doc._id, {
      $inc: { used: 1 },
      $set: {
        limit: maxLimit,
        remaining: Math.max(maxLimit - ((doc?.used || 0) + 1), 0),
      },
    });
  }

  /** Public: search/list accepted photographers */
  @Get()
  async searchPhotographers(
    @Req() req: Request,
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
    const usage = await this.consumeDailySearchQuotaIfAuthenticated(req);

    const smartPriority =
      String(query.smartLocationPriority || "").toLowerCase() === "1" ||
      String(query.smartLocationPriority || "").toLowerCase() === "true";
    const data = await this.photographersService.searchPhotographers({
      skill: query.skill,
      location: query.location,
      keyword: query.keyword,
      limit: Number(query.limit) || 60,
      viewerState: query.viewerState,
      viewerDistrict: query.viewerDistrict,
      smartLocationPriority: smartPriority,
    });

    if (!usage) return data;
    return { data, usage: { search: usage } };
  }

  /** Public: get single photographer by ID */
  @Get("username/:username")
  async getPhotographerByUsername(
    @Param("username") username: string,
    @Req() req: Request,
  ) {
    await this.consumeDailyProfileViewQuotaIfAuthenticated(req);

    const viewerId = extractOptionalViewerId(req);
    return this.photographersService.getPhotographerByUsername(
      username,
      viewerId,
    );
  }

  /** Public: get single photographer by ID (legacy support) */
  @Get(":id")
  async getPhotographerById(@Param("id") id: string, @Req() req: Request) {
    await this.consumeDailyProfileViewQuotaIfAuthenticated(req);

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
