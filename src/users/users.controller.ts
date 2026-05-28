import {
  Controller,
  Post,
  Body,
  UseGuards,
  Patch,
  Param,
  Get,
  Req,
  Query,
  Delete,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InfluencerProfileDto, BrandProfileDto } from "./dto/profile.dto";
import { UsersService } from "./users.service";
import { Request } from "express";
import { Model } from "mongoose";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { DailyUsageGuard } from "../monetization/guards/daily-usage.guard";
import { UsageLimit } from "../monetization/decorators/usage-limit.decorator";
import { PlansService } from "../plans/plans.service";

/** Decode JWT from request without throwing. Returns userId or null. */
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

@Controller("users")
export class UsersController {
  @Get("brands/name/:brandName")
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit("profile_view", "dailyProfileViewLimit")
  async getBrandByName(
    @Param("brandName") brandName: string,
    @Req() req: Request,
  ) {
    const viewerId = extractOptionalViewerId(req);
    return this.usersService.getBrandByName(brandName, viewerId);
  }
  constructor(
    private readonly usersService: UsersService,
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

  private shouldConsumeSearchQuota(params: {
    countSearch?: string;
    countReason?: string;
    page?: string;
    limit?: string;
  }): boolean {
    if (!parseBooleanLike(params.countSearch)) return false;

    const reason = String(params.countReason || "").trim().toLowerCase();
    if (reason === "query" || reason === "filter") return true;
    if (reason !== "pagination") return false;

    const page = Math.max(parseInt(String(params.page || "1"), 10) || 1, 1);
    const limit = Math.max(parseInt(String(params.limit || "120"), 10) || 120, 1);
    const offset = (page - 1) * limit;
    return offset >= 120;
  }

  @Get("influencers/:id")
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit("profile_view", "dailyProfileViewLimit")
  async getInfluencerById(@Param("id") id: string, @Req() req: Request) {
    const viewerId = extractOptionalViewerId(req);
    return this.usersService.getInfluencerById(id, viewerId);
  }

  @Get("influencers/username/:username")
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit("profile_view", "dailyProfileViewLimit")
  async getInfluencerByUsername(
    @Param("username") username: string,
    @Req() req: Request,
  ) {
    const viewerId = extractOptionalViewerId(req);
    return this.usersService.getInfluencerByUsername(
      username,
      viewerId,
    );
  }

  @Post("influencers/username/:username/track-impression")
  async trackInfluencerProfileImpression(@Param("username") username: string) {
    return this.usersService.trackInfluencerProfileImpression(username);
  }

  @Post("influencers/username/:username/track-click")
  async trackInfluencerProfileClick(@Param("username") username: string) {
    return this.usersService.trackInfluencerProfileClick(username);
  }

  @Get("check-username/:username")
  async checkUsername(@Param("username") username: string) {
    return this.usersService.checkUsername(username);
  }

  @Get("check-registration-conflicts")
  async checkRegistrationConflicts(
    @Query("userType") userType?: string,
    @Query("username") username?: string,
    @Query("brandUsername") brandUsername?: string,
    @Query("brandName") brandName?: string,
    @Query("email") email?: string,
    @Query("phoneNumber") phoneNumber?: string,
  ) {
    return this.usersService.checkRegistrationConflicts({
      userType,
      username,
      brandUsername,
      brandName,
      email,
      phoneNumber,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/images")
  async updateUserImages(
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only update your own images");
    }
    // Enforce plan image limit before saving
    const incomingImages: any[] =
      body.profileImages ?? body.brandLogo ?? body.products ?? [];
    await this.usersService.checkImageUploadLimit(id, incomingImages.length);
    return this.usersService.updateUserImages(id, body);
  }

  @Post("register")
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

  @Get("influencers/search")
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit("search", "dailySearchLimit")
  async searchInfluencers(
    @Query("q") q?: string,
    @Query("category") category?: string,
    @Query("state") state?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.usersService.searchInfluencers({
      q,
      category,
      state,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post("brands/name/:brandName/track-impression")
  async trackBrandProfileImpression(@Param("brandName") brandName: string) {
    return this.usersService.trackBrandProfileImpression(brandName);
  }

  @Post("brands/name/:brandName/track-click")
  async trackBrandProfileClick(@Param("brandName") brandName: string) {
    return this.usersService.trackBrandProfileClick(brandName);
  }

  @Get("influencers")
  async getInfluencers(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("lite") lite?: string,
    @Query("state") state?: string,
    @Query("district") district?: string,
    @Query("viewerState") viewerState?: string,
    @Query("viewerDistrict") viewerDistrict?: string,
    @Query("smartLocationPriority") smartLocationPriority?: string,
    @Query("countSearch") countSearch?: string,
    @Query("countReason") countReason?: string,
    @Req() req?: Request,
  ) {
    const usage = this.shouldConsumeSearchQuota({
      countSearch,
      countReason,
      page,
      limit,
    })
      ? await this.consumeDailySearchQuotaIfAuthenticated(req)
      : null;

    const viewerId = extractOptionalViewerId(req);
    const liteMode = String(lite || "").toLowerCase() === "1" || String(lite || "").toLowerCase() === "true";
    const smartPriority =
      String(smartLocationPriority || "").toLowerCase() === "1" ||
      String(smartLocationPriority || "").toLowerCase() === "true";
    const result = await this.usersService.getInfluencers(
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      viewerId,
      liteMode,
      {
        state,
        district,
        viewerState,
        viewerDistrict,
        smartLocationPriority: smartPriority,
      },
    );

    if (!usage) return result;
    if (Array.isArray(result)) {
      return { data: result, usage: { search: usage } };
    }
    return { ...(result || {}), usage: { search: usage } };
  }

  @Get("brands")
  @UseGuards(JwtAuthGuard, DailyUsageGuard)
  @UsageLimit("search", "dailySearchLimit")
  async getBrands(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("lite") lite?: string,
    @Req() req?: Request,
  ) {
    const viewerId = extractOptionalViewerId(req);
    const liteMode = String(lite || "").toLowerCase() === "1" || String(lite || "").toLowerCase() === "true";
    return this.usersService.getBrands(
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      viewerId,
      liteMode,
    );
  }

  // Self-service premium upgrade — placed BEFORE all /:id routes to prevent route shadowing
  @UseGuards(JwtAuthGuard)
  @Patch("self/upgrade-premium")
  async upgradeSelfPremium(
    @Req() req: any,
    @Body() body: { premiumDuration: "1m" | "3m" | "1y" },
  ) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.upgradeSelfPremium(userId, body.premiumDuration);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/accept")
  async acceptUser(@Param("id") id: string) {
    return this.usersService.acceptUser(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/decline")
  async declineUser(@Param("id") id: string) {
    return this.usersService.declineUser(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/delete")
  async deleteUser(@Param("id") id: string) {
    return this.usersService.deleteUser(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/restore")
  async restoreUser(@Param("id") id: string) {
    return this.usersService.restoreUser(id);
  }

  // Permanent delete — admin-only. Used for GDPR requests and admin-driven hard deletion
  // from the Deleted Users page (after the user has already been soft-deleted).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete(":id/permanent")
  async deletePermanently(@Param("id") id: string) {
    return this.usersService.deletePermanently(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/premium")
  async setPremium(
    @Param("id") id: string,
    @Body()
    body: {
      isPremium: boolean;
      premiumDuration?: string;
      type?: "influencer" | "brand" | "photographer";
    },
  ) {
    return this.usersService.setPremium(
      id,
      body.isPremium,
      body.premiumDuration,
      body.type,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get("influencer-profile")
  async getInfluencerProfile(@Req() req: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.getInfluencerProfileById(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("influencer-profile")
  async updateInfluencerProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.updateInfluencerProfile(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get("brand-profile")
  async getBrandProfile(@Req() req: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.getBrandProfileById(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("brand-profile")
  async updateBrandProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    return this.usersService.updateBrandProfile(userId, body);
  }
}
