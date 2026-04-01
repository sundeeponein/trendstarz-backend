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
  Inject,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PaymentService } from "./payment.service";

@Controller("payment")
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

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
    },
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    if (!body.transactionId)
      throw new BadRequestException("Transaction ID is required");
    if (!["1m", "3m", "1y"].includes(body.premiumDuration))
      throw new BadRequestException("Invalid premium duration");

    // Plan amounts for reference
    const planAmounts: Record<string, number> = {
      "1m": 399,
      "3m": 999,
      "1y": 2999,
    };
    const amount = planAmounts[body.premiumDuration];

    return this.paymentService.createPendingPayment(
      userId,
      body.transactionId,
      amount,
      body.premiumDuration,
      body.paymentMethod || "upi",
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
    return this.paymentService.approvePayment(paymentId, adminId);
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
   * Get payment details by ID
   * GET /payment/:id
   */
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  async getPaymentById(@Param("id") paymentId: string) {
    const payment = await this.paymentService.getPaymentById(paymentId);
    if (!payment) throw new BadRequestException("Payment not found");
    return payment;
  }
}

