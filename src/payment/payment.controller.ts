import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  BadRequestException,
  Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PaymentService } from "./payment.service";
import {
  assertDisplayedPriceMatches,
  billingCycleFor,
  computeSubscriptionPrice,
  SubscriptionPrice,
} from "../plans/subscription-price.util";

const USER_TYPE_BY_ROLE: Record<
  string,
  "Influencer" | "Brand" | "Photographer"
> = {
  influencer: "Influencer",
  brand: "Brand",
  photographer: "Photographer",
};

@Controller("payment")
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Get current user's recent payments (pending, approved, rejected)
   * GET /payment/my
   */
  @UseGuards(JwtAuthGuard)
  @Get("my")
  async getMyPayments(@Req() req: any, @Query("limit") limit: string = "5") {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    return this.paymentService.getPaymentsByUser(userId, parseInt(limit));
  }

  /**
   * Record a pending UPI payment
   * POST /payment
   * Body: { transactionId, premiumDuration, userType }
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  async recordUpiPayment(
    @Body()
    body: {
      transactionId: string;
      premiumDuration: "1m" | "3m" | "1y";
      userType?: "Influencer" | "Brand" | "Photographer";
      paymentMethod?: "upi" | "qr";
      couponCode?: string;
      // The total the page showed — checked against the server price, never charged.
      finalAmount?: number;
    },
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    if (!body.transactionId)
      throw new BadRequestException("Transaction ID is required");
    if (!["1m", "3m", "1y"].includes(body.premiumDuration))
      throw new BadRequestException("Invalid premium duration");

    // The plan (and so the price) follows the signed-in account, not the request body.
    const userType =
      USER_TYPE_BY_ROLE[String(req.user?.role || "").toLowerCase()] ||
      body.userType ||
      "Influencer";
    const plan =
      await this.paymentService.plansService.findProPlanForUserType(userType);
    const billingCycle = billingCycleFor(body.premiumDuration);
    let price: SubscriptionPrice;
    try {
      price = computeSubscriptionPrice(plan, billingCycle, body.couponCode);
      assertDisplayedPriceMatches(body.finalAmount, price);
    } catch (e: any) {
      throw new BadRequestException(e?.message || "Invalid price");
    }
    if (price.baseRupees <= 0) {
      throw new BadRequestException("Plan price not found");
    }

    return this.paymentService.createPendingPayment(
      userId,
      body.transactionId,
      price,
      body.premiumDuration,
      body.paymentMethod || "upi",
      userType,
    );
  }

  /**
   * Get all pending payments (Admin only)
   * GET /payment/pending
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("pending")
  async getPendingPayments(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "10",
  ) {
    return this.paymentService.getPendingPayments(
      parseInt(page),
      parseInt(limit),
    );
  }

  /**
   * Approve a payment and activate premium for user (Admin only)
   * PATCH /payment/:id/approve
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/approve")
  async approvePayment(@Param("id") paymentId: string, @Req() req: any) {
    const adminId = req.user?.userId;
    if (!adminId) throw new BadRequestException("Not authenticated");
    return await this.paymentService.approvePayment(paymentId, adminId);
  }

  /**
   * Reject a payment (Admin only)
   * PATCH /payment/:id/reject
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/reject")
  async rejectPayment(
    @Param("id") paymentId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const adminId = req.user?.userId;
    if (!adminId) throw new BadRequestException("Not authenticated");
    return this.paymentService.rejectPayment(
      paymentId,
      body.reason || "No reason provided",
    );
  }

  /**
   * Mark an approved premium payment as refunded (Admin only)
   * PATCH /payment/:id/refund
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(":id/refund")
  async refundPayment(
    @Param("id") paymentId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const adminId = req.user?.userId;
    if (!adminId) throw new BadRequestException("Not authenticated");
    return this.paymentService.refundPayment(
      paymentId,
      adminId,
      body.reason || "Refund marked by admin",
    );
  }

  /**
   * Premium payment summary for admin cards
   * GET /payment/summary
   * GET /payment/summary?days=7  — restrict to the last N days (e.g. dashboard widgets)
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("summary")
  async getAdminSummary(@Query("days") days?: string) {
    const parsedDays = Number(days);
    const since =
      Number.isFinite(parsedDays) && parsedDays > 0
        ? new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000)
        : undefined;
    return this.paymentService.getAdminSummary(since);
  }

  /**
   * Get payments by status (Admin only)
   * GET /payment/by-status?status=approved|rejected|pending|refunded
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("by-status")
  async getPaymentsByStatus(
    @Query("status") status: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "50",
  ) {
    if (
      !status ||
      !["approved", "rejected", "pending", "refunded"].includes(status)
    ) {
      throw new BadRequestException("Invalid status");
    }
    return this.paymentService.getPaymentsByStatus(
      status as "approved" | "rejected" | "pending" | "refunded",
      parseInt(page),
      parseInt(limit),
    );
  }

  /**
   * Get payment details by ID
   * GET /payment/:id
   */
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  async getPaymentById(@Param("id") paymentId: string) {
    const result = await this.paymentService.getPaymentById(paymentId);
    if (!result.payment) throw new BadRequestException("Payment not found");
    return result;
  }
}
