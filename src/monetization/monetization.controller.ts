import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MonetizationService } from "./monetization.service";

@Controller("monetization")
export class MonetizationController {
  constructor(private readonly monetizationService: MonetizationService) {}

  private normalizeUserRole(roleRaw: unknown): "brand" | "influencer" | "photographer" {
    const role = String(roleRaw || "").toLowerCase();
    if (role === "brand") return "brand";
    if (role === "photographer") return "photographer";
    return "influencer";
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/fee-settings")
  getFeeSettings() {
    return this.monetizationService.getFeeSettings();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch("admin/fee-settings")
  updateFeeSettings(@Body() body: any) {
    return this.monetizationService.updateFeeSettings(body);
  }

  @UseGuards(JwtAuthGuard)
  @Post("subscriptions/order")
  createSubscriptionOrder(
    @Req() req: any,
    @Body() body: { planId: string; billingCycle: "monthly" | "yearly" },
  ) {
    const userId = req.user?.userId;
    const role = this.normalizeUserRole(req.user?.role);
    return this.monetizationService.createSubscriptionOrder({
      userId,
      userRole: role,
      planId: body.planId,
      billingCycle: body.billingCycle,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post("invite-unlock/order")
  createInviteUnlockOrder(
    @Req() req: any,
    @Body() body: { inviteId: string },
  ) {
    const userId = req.user?.userId;
    const role = this.normalizeUserRole(req.user?.role);
    return this.monetizationService.createInviteUnlockOrder({
      inviteId: body.inviteId,
      payerId: userId,
      payerRole: role,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post("razorpay/verify")
  verifyRazorpayPayment(
    @Req() req: any,
    @Body()
    body: {
      orderId: string;
      paymentId: string;
      signature: string;
      paymentType: "subscription" | "invite_unlock";
    },
  ) {
    return this.monetizationService.verifyRazorpayPayment({
      orderId: body.orderId,
      paymentId: body.paymentId,
      signature: body.signature,
      paymentType: body.paymentType,
      userId: req.user?.userId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post("social-clicks")
  trackSocialClick(
    @Req() req: any,
    @Body()
    body: {
      targetUserId: string;
      targetRole: "brand" | "influencer" | "photographer";
      platform: string;
      url: string;
      source?: string;
    },
  ) {
    return this.monetizationService.trackSocialClick({
      actorUserId: req.user?.userId,
      actorRole: this.normalizeUserRole(req.user?.role),
      targetUserId: body.targetUserId,
      targetRole: body.targetRole,
      platform: body.platform,
      url: body.url,
      source: body.source,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip || req.connection?.remoteAddress || "",
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get("usage/my")
  myUsage(@Req() req: any) {
    return this.monetizationService.getUsageSummary(
      req.user?.userId,
      this.normalizeUserRole(req.user?.role),
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/revenue-summary")
  adminRevenueSummary(@Query("days") days = "30") {
    return this.monetizationService.adminRevenueSummary(Number(days || 30));
  }
}
