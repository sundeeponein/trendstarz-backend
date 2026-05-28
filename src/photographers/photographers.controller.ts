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

function nextDayKey(date = new Date()): string {
  return toDayKey(new Date(date.getTime() + 24 * 60 * 60 * 1000));
}

function parseBooleanLike(value: unknown): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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
        `You have exhausted today's usage limit (${maxLimit}/day on your current plan). You can search again on ${nextDayKey()}. Upgrade your plan for higher limits.`,
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

  private shouldConsumeSearchQuota(query: {
    countSearch?: string;
    countReason?: string;
    page?: string;
    limit?: string;
  }): boolean {
    if (!parseBooleanLike(query.countSearch)) return false;

    const reason = String(query.countReason || "").trim().toLowerCase();
    if (reason === "query" || reason === "filter") return true;
    if (reason !== "pagination") return false;

    const page = Math.max(parseInt(String(query.page || "1"), 10) || 1, 1);
    const limit = Math.max(parseInt(String(query.limit || "120"), 10) || 120, 1);
    const offset = (page - 1) * limit;
    return offset >= 120;
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
      page?: string;
      limit?: string;
      viewerState?: string;
      viewerDistrict?: string;
      smartLocationPriority?: string;
      countSearch?: string;
      countReason?: string;
    },
  ) {
    const usage = this.shouldConsumeSearchQuota(query)
      ? await this.consumeDailySearchQuotaIfAuthenticated(req)
      : null;

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
