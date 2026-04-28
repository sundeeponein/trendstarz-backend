import { Injectable } from "@nestjs/common";
import Razorpay from "razorpay";
import * as crypto from "crypto";

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
   * Create a Razorpay order.
   * amount must be in paise (₹1 = 100 paise).
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
   * Verify the Razorpay payment signature.
   * Called after the frontend receives razorpay_payment_id / razorpay_order_id / razorpay_signature.
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
   * Fetch the order details to double-check status on the server side.
   */
  async fetchOrder(orderId: string): Promise<any> {
    const razorpay = this.getClient();
    return await (razorpay.orders.fetch as any)(orderId);
  }
}
