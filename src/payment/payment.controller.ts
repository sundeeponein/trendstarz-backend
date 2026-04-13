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
      userType: "Influencer" | "Brand";
      paymentMethod?: "upi" | "qr";
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

    // Use finalAmount from frontend if provided, else fetch from plan config
    let amount = body.finalAmount;
    if (typeof amount !== "number") {
      // Fetch plan from DB (synced from plans-config.json)
      const plan =
        await this.paymentService.plansService.findProPlanForUserType(
          body.userType,
        );
      const billingCycle =
        body.premiumDuration === "1m"
          ? "monthly"
          : body.premiumDuration === "3m"
            ? "quarterly"
            : "yearly";
      amount = plan?.price?.[billingCycle];
      if (typeof amount !== "number") {
        throw new BadRequestException("Plan price not found");
      }
    }

    return this.paymentService.createPendingPayment(
      userId,
      body.transactionId,
      amount,
      body.premiumDuration,
      body.paymentMethod || "upi",
      body.userType || "Influencer",
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
  approvePayment() {
    // Manual approval is obsolete; payments are auto-approved
    return {
      success: false,
      message: "Manual approval is obsolete. All payments are auto-approved.",
    };
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
   * Get payments by status (Admin only)
   * GET /payment/by-status?status=approved|rejected
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("by-status")
  async getPaymentsByStatus(
    @Query("status") status: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "50",
  ) {
    if (!status || !["approved", "rejected", "pending"].includes(status)) {
      throw new BadRequestException("Invalid status");
    }
    return this.paymentService.getPaymentsByStatus(
      status as "approved" | "rejected" | "pending",
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
