import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CollaborationScoreService } from "./collaboration-score.service";
import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";

// Route ordering matters here: literal segments ("run", "admin", "settings")
// must be declared before the ":userId" wildcard GET, or Express/Nest will
// try to match them as a userId value first.
// Note: main.ts already sets a global "api" prefix (app.setGlobalPrefix),
// so this resolves to /api/audit/... — do not prefix with "api/" here too.
@Controller("audit")
export class CollaborationScoreController {
  constructor(
    private readonly service: CollaborationScoreService,
    private readonly settingsService: CollaborationScoreSettingsService,
  ) {}

  private requesterId(req: any): string {
    return String(req?.user?.userId || req?.user?.sub || req?.user?.id || "").trim();
  }

  private assertAdmin(req: any) {
    if (String(req?.user?.role || "").toLowerCase() !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
  }

  /**
   * POST /api/audit/preview — anonymous, pre-registration teaser. No JWT
   * guard by design; tightly throttled (well below the app-wide default)
   * since every call fans out to the YouTube Data API.
   */
  @Throttle({ default: { ttl: 600000, limit: 5 } })
  @Post("preview")
  previewFromYoutubeUrl(@Body() body: any) {
    return this.service.previewFromYoutubeUrl(body?.youtubeUrl);
  }

  /** POST /api/audit/run — sync-only; self-trigger or admin-on-behalf-of. */
  @UseGuards(JwtAuthGuard)
  @Post("run")
  async runAudit(@Req() req: any, @Body() body: any) {
    const requesterId = this.requesterId(req);
    const targetUserId = String(body?.userId || "").trim();
    if (targetUserId && targetUserId !== requesterId) {
      this.assertAdmin(req);
      return this.service.runAudit(targetUserId, body?.role || req?.user?.role, "ADMIN");
    }
    return this.service.runAudit(requesterId, req?.user?.role, "USER");
  }

  /** POST /api/audit/reanalysis/order — self-only; creates a Razorpay order for the paid re-analysis. */
  @UseGuards(JwtAuthGuard)
  @Post("reanalysis/order")
  createReanalysisOrder(@Req() req: any) {
    const requesterId = this.requesterId(req);
    return this.service.createReanalysisOrder(requesterId, req?.user?.role);
  }

  /** POST /api/audit/reanalysis/verify — verifies payment, then runs the audit. */
  @UseGuards(JwtAuthGuard)
  @Post("reanalysis/verify")
  verifyReanalysisPayment(@Req() req: any, @Body() body: any) {
    const requesterId = this.requesterId(req);
    return this.service.verifyReanalysisPayment(requesterId, req?.user?.role, {
      orderId: body?.orderId,
      paymentId: body?.paymentId,
      signature: body?.signature,
    });
  }

  /** GET /api/audit/admin — paginated list + optional ?summary=true. */
  @UseGuards(JwtAuthGuard)
  @Get("admin")
  adminList(@Req() req: any, @Query() query: any) {
    return this.service.adminList(req?.user, query);
  }

  /**
   * GET/PUT /api/audit/settings — GET is an additive extension of the spec's
   * 4 endpoints so the admin settings UI has something to read before it PUTs.
   */
  @UseGuards(JwtAuthGuard)
  @Get("settings")
  async getSettings(@Req() req: any) {
    this.assertAdmin(req);
    return this.settingsService.getSettings();
  }

  @UseGuards(JwtAuthGuard)
  @Put("settings")
  async updateSettings(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    return this.settingsService.updateSettings(body, { userId: this.requesterId(req), role: req?.user?.role });
  }

  /** POST /api/audit/settings/reset — admin-only; deletes current config and re-seeds JSON defaults. */
  @UseGuards(JwtAuthGuard)
  @Post("settings/reset")
  async resetSettings(@Req() req: any) {
    this.assertAdmin(req);
    return this.settingsService.resetToDefaults({ userId: this.requesterId(req), role: req?.user?.role });
  }

  /** GET /api/audit/:userId — full detail for self, brand-safe filtered otherwise. */
  @UseGuards(JwtAuthGuard)
  @Get(":userId")
  getAudit(@Req() req: any, @Param("userId") userId: string) {
    return this.service.getAuditForUser(userId, req?.user);
  }

  /** GET /api/audit/:userId/history — self/admin only; every past version, never overwritten. */
  @UseGuards(JwtAuthGuard)
  @Get(":userId/history")
  getAuditHistory(@Req() req: any, @Param("userId") userId: string, @Query("limit") limit?: string) {
    return this.service.getAuditHistory(userId, req?.user, limit ? Number(limit) : undefined);
  }

  /** GET /api/audit/:userId/payments — admin-only; every re-analysis payment for one creator. */
  @UseGuards(JwtAuthGuard)
  @Get(":userId/payments")
  getReanalysisPayments(@Req() req: any, @Param("userId") userId: string) {
    return this.service.getReanalysisPayments(userId, req?.user);
  }
}
