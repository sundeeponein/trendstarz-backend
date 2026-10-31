import { recordAdminAction, settingsDiff } from "../utils/admin-action-log.util";
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { PlansService } from "./plans.service";
import { OfferEmailService } from "./offer-email.service";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";

@Controller("plans")
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly offerEmailService: OfferEmailService,
  ) {}

  // ── Admin endpoints ───────────────────────────────────────────────────────

  /** GET /plans/admin/all — all plans */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/all")
  listAll() {
    return this.plansService.listAll();
  }

  /** POST /plans/admin — create plan */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin")
  async create(@Body() dto: any, @Req() req?: any) {
    const plan: any = await this.plansService.create(dto);
    const created = plan?.toObject?.() ?? plan?.plan ?? plan;
    await recordAdminAction(req, "create_plan", { type: "plan", id: String(created?._id || "") }, { changes: settingsDiff({}, created) });
    return plan;
  }

  /** PATCH /plans/admin/:id — update plan */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch("admin/:id")
  async update(@Param("id") id: string, @Body() dto: any, @Req() req?: any) {
    const before: any = await this.plansService.planModel.findById(id).lean();
    const result: any = await this.plansService.update(id, dto);
    const after: any = await this.plansService.planModel.findById(id).lean();
    const changes = settingsDiff(before, after);
    if (Object.keys(changes).length) await recordAdminAction(req, "update_plan", { type: "plan", id }, { changes });
    return result;
  }

  /** DELETE /plans/admin/:id — delete plan **/
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete("admin/:id")
  async remove(@Param("id") id: string, @Req() req?: any) {
    const before: any = await this.plansService.planModel.findById(id).lean();
    const result = await this.plansService.remove(id);
    await recordAdminAction(req, "delete_plan", { type: "plan", id }, { changes: settingsDiff(before, {}) });
    return result;
  }

  // ── Admin: email the running offer to free creators (sent only on Send) ──

  /** POST /plans/admin/:id/offer-email/preview — recipients, counts and the rendered email */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/:id/offer-email/preview")
  offerEmailPreview(@Param("id") id: string, @Body() body: any) {
    return this.offerEmailService.preview(id, body?.kind, body?.benefits);
  }

  /** POST /plans/admin/:id/offer-email/test — one copy to the given address */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/:id/offer-email/test")
  async offerEmailTest(@Param("id") id: string, @Body() body: any, @Req() req?: any) {
    const result = await this.offerEmailService.sendTest(id, body?.kind, body?.to, body?.benefits);
    await recordAdminAction(req, "offer_email_test", { type: "plan", id }, { kind: body?.kind, to: result.to });
    return result;
  }

  /** POST /plans/admin/:id/offer-email/send — starts sending to free creators not yet sent this email */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/:id/offer-email/send")
  async offerEmailSend(@Param("id") id: string, @Body() body: any, @Req() req?: any) {
    const result = await this.offerEmailService.sendAll(id, body?.kind, body?.benefits, body?.limit);
    await recordAdminAction(req, "offer_email_send", { type: "plan", id }, { kind: body?.kind, limit: result.limit });
    return result;
  }

  /** POST /plans/offer-emails/unsubscribe — public "Stop offer emails" link (signed token) */
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post("offer-emails/unsubscribe")
  offerEmailUnsubscribe(@Body() body: any) {
    return this.offerEmailService.unsubscribe(body?.t);
  }

  /** GET /plans?userType=INFLUENCER|BRAND — active plans **/
  @Get()
  listActive(@Query("userType") userType?: string) {
    return this.plansService.listActive(userType);
  }

  /** GET /plans/my/subscription — current user subscription **/
  @UseGuards(JwtAuthGuard)
  @Get("my/subscription")
  async mySubscription(@Req() req: any) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    const sub = await this.plansService.getActiveSubscription(userId);
    return { success: true, subscription: sub };
  }

  /** GET /plans/my/capabilities — full plan caps (features + limits) **/
  @UseGuards(JwtAuthGuard)
  @Get("my/capabilities")
  async myCapabilities(@Req() req: any) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    const caps = await this.plansService.getUserPlanCapabilities(userId);
    return { success: true, ...caps };
  }

  /** GET /plans/my/subscriptions — subscription history */
  @UseGuards(JwtAuthGuard)
  @Get("my/subscriptions")
  async mySubscriptions(@Req() req: any) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    return this.plansService.getUserSubscriptions(userId);
  }

  /** GET /plans/admin/user/:userId/capabilities — admin view of a user's plan **/
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/user/:userId/capabilities")
  async userCapabilities(@Param("userId") userId: string) {
    const caps = await this.plansService.getUserPlanCapabilities(userId);
    return { success: true, ...caps };
  }
}
