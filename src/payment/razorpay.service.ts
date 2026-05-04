import { Injectable } from "@nestjs/common";
import Razorpay from "razorpay";
import * as crypto from "crypto";

/**
 * @future-only RazorpayService
 *
 * This service is preserved for the automated payment phase.
 * It is NOT wired into any active campaign payment flow.
 *
 * Current MVP flow: brand pays manually via UPI/QR, admin verifies UTR,
 * admin pays influencer via UPI. All handled in PaymentsPayoutsService.
 *
 * When to activate:
 *  1. Set CampaignTransaction.gateway = 'razorpay'
 *  2. Call createOrder() from PaymentsPayoutsService.submitPaymentProof()
 *  3. Verify webhook signature via verifySignature()
 *  4. Auto-capture: trigger markPayoutPaid() on successful Razorpay webhook
 *
 * Do NOT remove this service. It is registered in PaymentModule.
 */
@Injectable()
export class RazorpayService {
  private razorpay: Razorpay | null = null;

  constructor() {}

  private getClient(): Razorpay {
    if (this.razorpay) {
      return this.razorpay;
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new Error(
        "Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in environment variables. Please check your .env file.",
      );
    }

    this.razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    return this.razorpay;
  }

  /**
   * @future-only
   * Create a Razorpay order for automated payment capture.
   * amount must be in paise (₹1 = 100 paise).
   * NOT USED in MVP — manual UPI flow is active instead.
   */
  async createOrder(
    amountPaise: number,
    metadata: { userId: string; premiumDuration: string },
  ) {
    const razorpay = this.getClient();
    const order = await (razorpay.orders.create as any)({
      amount: amountPaise,
      currency: "INR",
      notes: {
        userId: metadata.userId,
        premiumDuration: metadata.premiumDuration,
      },
    });
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || "",
    };
  }

  /**
   * @future-only
   * Verify the Razorpay payment signature after automated capture.
   * NOT USED in MVP — manual UTR verification by admin is active instead.
   */
  verifySignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    const secret = process.env.RAZORPAY_KEY_SECRET || "";
    const body = orderId + "|" + paymentId;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");
    return expectedSignature === signature;
  }

  /**
   * @future-only
   * Fetch Razorpay order details for server-side status verification.
   * NOT USED in MVP — admin manually confirms UTR instead.
   */
  async fetchOrder(orderId: string): Promise<any> {
    const razorpay = this.getClient();
    return await (razorpay.orders.fetch as any)(orderId);
  }
}
