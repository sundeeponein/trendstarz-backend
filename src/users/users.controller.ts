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
  BadRequestException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { AllowPendingDeletion } from "../auth/allow-pending-deletion.decorator";
import { InfluencerProfileDto, BrandProfileDto } from "./dto/profile.dto";
import { UsersService } from "./users.service";
import { Request } from "express";
import { Model } from "mongoose";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { DailyUsageGuard } from "../monetization/guards/daily-usage.guard";
import { UsageLimit } from "../monetization/decorators/usage-limit.decorator";
import { PlansService } from "../plans/plans.service";
import { PhotographersService } from "../photographers/photographers.service";
import { isLocalAuthBypassRequest } from "../utils/local-auth-bypass.util";

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
    private readonly photographersService: PhotographersService,
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

  @UseGuards(JwtAuthGuard)
  @Get(":id/marketing-consent")
  async getMarketingConsent(@Param("id") id: string, @Req() req: Request) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only view your own settings");
    }
    return this.usersService.getMarketingConsent(id);
  }

  /**
   * Self-service opt-in/out for showing this user's photo/logo on public
   * marketing surfaces (homepage hero banner + slider). Being premium or
   * verified is not sufficient consent — see users.service.ts setMarketingConsent.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(":id/marketing-consent")
  async updateMarketingConsent(
    @Param("id") id: string,
    @Body() body: { featuredInMarketing?: boolean },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only update your own settings");
    }
    return this.usersService.setMarketingConsent(
      id,
      body?.featuredInMarketing === true,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get(":id/profile-visibility")
  async getProfileVisibility(@Param("id") id: string, @Req() req: Request) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only view your own settings");
    }
    return this.usersService.getProfileVisibility(id);
  }

  /** Who can view this profile — PUBLIC / MEMBERS_ONLY / PRIVATE. See users.service.ts setProfileVisibility. */
  @UseGuards(JwtAuthGuard)
  @Patch(":id/profile-visibility")
  async updateProfileVisibility(
    @Param("id") id: string,
    @Body() body: { profileVisibility?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only update your own settings");
    }
    const allowed = ["PUBLIC", "MEMBERS_ONLY", "PRIVATE"];
    const value = String(body?.profileVisibility || "").toUpperCase();
    if (!allowed.includes(value)) {
      throw new BadRequestException(
        "profileVisibility must be one of PUBLIC, MEMBERS_ONLY, PRIVATE",
      );
    }
    return this.usersService.setProfileVisibility(id, value as any);
  }

  /** Self-service "please call me to verify my mobile" ask — see users.service.ts requestMobileCallback. */
  @UseGuards(JwtAuthGuard)
  @Patch(":id/request-mobile-callback")
  async requestMobileCallback(@Param("id") id: string, @Req() req: Request) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only request a callback for your own account");
    }
    return this.usersService.requestMobileCallback(id);
  }

  /**
   * Self-service "Delete Account" (Settings → Delete Account). Requires the
   * caller's current password. Soft-deletes with status "deletion_pending" —
   * hidden from search/homepage immediately, hard-deleted automatically
   * after the grace period (see UsersService.cleanupExpiredSelfDeletionRequests).
   */
  @UseGuards(JwtAuthGuard)
  @Post(":id/self-delete")
  async selfDeleteAccount(
    @Param("id") id: string,
    @Body() body: { password?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only delete your own account");
    }
    return this.usersService.requestSelfDeletion(id, body?.password || "");
  }

  /** Cancels a pending self-deletion request, during the grace period only. */
  @UseGuards(JwtAuthGuard)
  @AllowPendingDeletion()
  @Post(":id/cancel-deletion")
  async cancelSelfDeletion(@Param("id") id: string, @Req() req: Request) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only restore your own account");
    }
    return this.usersService.cancelSelfDeletion(id);
  }

  /** Returns whether this account has a pending self-deletion request, and when the grace period ends. */
  @UseGuards(JwtAuthGuard)
  @AllowPendingDeletion()
  @Get(":id/deletion-status")
  async getSelfDeletionStatus(@Param("id") id: string, @Req() req: Request) {
    const userId = (req as any).user?.userId;
    if (userId !== id) {
      throw new ForbiddenException("You can only view your own account status");
    }
    return this.usersService.getSelfDeletionStatus(id);
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
    @Query("creatorType") creatorType?: string,
    @Query("state") state?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.usersService.searchInfluencers({
      q,
      category,
      creatorType,
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

  @Get("platform-stats")
  async getPlatformStats() {
    return this.usersService.getPlatformStats();
  }

  /**
   * Welcome Page "Featured" sections — eligible-only (accepted + verified +
   * approved), weighted-random selection (60% recently active / 20% recently
   * approved / 20% random). NOT identical for guests vs logged-in viewers:
   * guests only see Premium profiles (a registration incentive); logged-in
   * viewers see the full Public + Members-Only eligible set regardless of
   * Premium. See applyApprovedEligibilityFilter's requirePremium option.
   */
  @Get("featured-profiles")
  async getFeaturedProfiles(
    @Req() req: any,
    @Query("influencerLimit") influencerLimit?: string,
    @Query("brandLimit") brandLimit?: string,
    @Query("photographerLimit") photographerLimit?: string,
    @Query("viewerState") viewerState?: string,
    @Query("viewerDistrict") viewerDistrict?: string,
    @Query("viewerCountry") viewerCountry?: string,
  ) {
    const viewerId = extractOptionalViewerId(req);
    const viewerIsAuthenticated = !!viewerId;
    const viewerLocation = await this.usersService.resolveDiscoveryViewerLocation(
      viewerId,
      {
        state: viewerState,
        district: viewerDistrict,
        country: viewerCountry,
        source: viewerIsAuthenticated ? "registered_profile" : "country_fallback",
      },
    );
    const [influencers, brands, photographers] = await Promise.all([
      this.usersService.getFeaturedInfluencers(
        Number(influencerLimit) || 8,
        viewerIsAuthenticated,
        viewerLocation,
      ),
      this.usersService.getFeaturedBrands(
        Number(brandLimit) || 6,
        viewerIsAuthenticated,
        viewerLocation,
      ),
      this.photographersService.getFeaturedPhotographers(
        Number(photographerLimit) || 6,
        viewerIsAuthenticated,
        viewerLocation,
      ),
    ]);
    return { influencers, brands, photographers };
  }

  /**
   * Homepage hero banner + hero slider images — one eligible, explicitly
   * opted-in (featuredInMarketing: true) image per role. Public endpoint,
   * used by guests too.
   */
  @Get("hero-showcase-images")
  async getHeroShowcaseImages(
    @Req() req: any,
    @Query("viewerState") viewerState?: string,
    @Query("viewerDistrict") viewerDistrict?: string,
    @Query("viewerCountry") viewerCountry?: string,
  ) {
    const viewerId = extractOptionalViewerId(req);
    const viewerLocation = await this.usersService.resolveDiscoveryViewerLocation(
      viewerId,
      {
        state: viewerState,
        district: viewerDistrict,
        country: viewerCountry,
        source: viewerId ? "registered_profile" : "country_fallback",
      },
    );
    const [{ influencer, brand }, photographer] = await Promise.all([
      this.usersService.getHeroShowcaseInfluencerAndBrandImages(viewerLocation),
      this.photographersService.getHeroShowcasePhotographerImage(viewerLocation),
    ]);
    return { influencer, brand, photographer };
  }

  @Get("influencers")
  async getInfluencers(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("lite") lite?: string,
    @Query("state") state?: string,
    @Query("district") district?: string,
    @Query("creatorType") creatorType?: string,
    @Query("viewerState") viewerState?: string,
    @Query("viewerDistrict") viewerDistrict?: string,
    @Query("viewerCountry") viewerCountry?: string,
    @Query("smartLocationPriority") smartLocationPriority?: string,
    @Query("category") category?: string,
    @Query("q") q?: string,
    @Query("campaignEligible") campaignEligible?: string,
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
    const campaignEligibleOnly =
      String(campaignEligible || "").toLowerCase() === "1" ||
      String(campaignEligible || "").toLowerCase() === "true";
    const result = await this.usersService.getInfluencers(
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      viewerId,
      liteMode,
      {
        state,
        district,
        creatorType,
        viewerState,
        viewerDistrict,
        viewerCountry,
        smartLocationPriority: smartPriority,
        campaignEligible: campaignEligibleOnly,
        category,
        q,
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
  async declineUser(
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    return this.usersService.declineUser(id, body?.reason);
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
    return this.usersService.updateInfluencerProfile(
      userId,
      body,
      isLocalAuthBypassRequest(req),
    );
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
    return this.usersService.updateBrandProfile(
      userId,
      body,
      isLocalAuthBypassRequest(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch("influencer-profile/admin-social-notifications/dismiss")
  async dismissAdminSocialNotifications(
    @Req() req: any,
    @Body() body?: { action?: "confirmed" | "cancelled" },
  ) {
    const userId = req.user?.userId || req.user?.sub || req.user?.id;
    await this.usersService.dismissAdminSocialNotifications(userId, body?.action);
    return { message: "Notifications dismissed" };
  }
}
