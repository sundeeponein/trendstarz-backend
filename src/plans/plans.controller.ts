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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";

@Controller("plans")
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

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
  create(@Body() dto: any) {
    return this.plansService.create(dto);
  }

  /** PATCH /plans/admin/:id — update plan */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch("admin/:id")
  update(@Param("id") id: string, @Body() dto: any) {
    return this.plansService.update(id, dto);
  }

  /** DELETE /plans/admin/:id — delete plan **/
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete("admin/:id")
  remove(@Param("id") id: string) {
    return this.plansService.remove(id);
  }

  /** POST /plans/admin/seed — seed default plans **/
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/seed")
  // seed() {
  //   return this.plansService.seedDefaultPlans();
  // }

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

  /** GET /plans/admin/user/:userId/capabilities — admin view of a user's plan */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/user/:userId/capabilities")
  async userCapabilities(@Param("userId") userId: string) {
    const caps = await this.plansService.getUserPlanCapabilities(userId);
    return { success: true, ...caps };
  }
}
