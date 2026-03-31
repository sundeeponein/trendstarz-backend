import { Controller, Post, Body, UseGuards, Req } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PaymentService } from "./payment.service";
import { RazorpayService } from "./razorpay.service";

// Plan amounts in paise (INR × 100)
const PLAN_AMOUNTS: Record<string, number> = {
  "1m": 39900,   // ₹399
  "3m": 99900,   // ₹999
  "1y": 299900,  // ₹2,999
};

@Controller("payment")
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly razorpayService: RazorpayService,
  ) {}

  /**
   * Step 1: Create a Razorpay order.
   * Frontend receives orderId + keyId and opens the Razorpay checkout popup.
   */
  @UseGuards(JwtAuthGuard)
  @Post("create-order")
  async createOrder(
    @Body() body: { premiumDuration: "1m" | "3m" | "1y" },
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");
    const amount = PLAN_AMOUNTS[body.premiumDuration];
    if (!amount) throw new BadRequestException("Invalid plan duration");
    return this.razorpayService.createOrder(amount, {
      userId,
      premiumDuration: body.premiumDuration,
    });
  }

  /**
   * Step 2: Verify Razorpay payment signature and activate premium.
   * Called after frontend receives payment success callback.
   */
  @UseGuards(JwtAuthGuard)
  @Post("verify-payment")
  async verifyPayment(
    @Body()
    body: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      premiumDuration: "1m" | "3m" | "1y";
    },
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException("Not authenticated");

    const isValid = this.razorpayService.verifySignature(
      body.razorpay_order_id,
      body.razorpay_payment_id,
      body.razorpay_signature,
    );
    if (!isValid) {
      throw new BadRequestException(
        "Payment verification failed. Signature mismatch.",
      );
    }
    return this.paymentService.confirmUpgrade(userId, body.premiumDuration);
  }
}

