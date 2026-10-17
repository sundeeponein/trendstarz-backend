import { Injectable } from "@nestjs/common";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import axios, { AxiosRequestConfig } from "axios";

/**
 * RazorpayService
 *
 * Active pay-in flow:
 *  - subscription collections use Razorpay Checkout order + signature verify
 *  - campaign collections use Razorpay Checkout order + signature verify
 *
 * Payouts remain manual by default. RazorpayX helpers are retained behind
 * AUTO_PAYOUT_ENABLED for a later operational mode.
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
   * Create a Razorpay Checkout order.
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
   * Verify Razorpay Checkout signature after successful payment.
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
   * Fetch Razorpay order details for server-side status verification.
   */
  async fetchOrder(orderId: string): Promise<any> {
    const razorpay = this.getClient();
    return await (razorpay.orders.fetch as any)(orderId);
  }

  isCheckoutConfigured(): boolean {
    return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  }

  private getRazorpayXCredentials() {
    const keyId =
      process.env.RAZORPAYX_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    const keySecret =
      process.env.RAZORPAYX_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || "";
    const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER || "";
    const baseUrl = process.env.RAZORPAYX_BASE_URL || "https://api.razorpay.com/v1";
    return { keyId, keySecret, accountNumber, baseUrl };
  }

  isPayoutsConfigured(): boolean {
    const creds = this.getRazorpayXCredentials();
    return !!(creds.keyId && creds.keySecret && creds.accountNumber);
  }

  private async razorpayXPost(path: string, payload: any): Promise<any> {
    const creds = this.getRazorpayXCredentials();
    if (!creds.keyId || !creds.keySecret) {
      throw new Error("Missing RazorpayX API credentials");
    }

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString(
      "base64",
    );
    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    };

    const { data } = await axios.post(
      `${creds.baseUrl}${path}`,
      payload,
      config,
    );
    return data;
  }

  async createPayoutByUpi(input: {
    amountPaise: number;
    recipientName: string;
    recipientUpiId: string;
    referenceId: string;
    narration: string;
    notes?: Record<string, string>;
  }): Promise<{
    payoutId: string;
    status: string;
    utr?: string;
    fundAccountId?: string;
    contactId?: string;
  }> {
    const creds = this.getRazorpayXCredentials();
    if (!creds.accountNumber) {
      throw new Error("Missing RAZORPAYX_ACCOUNT_NUMBER");
    }

    const contact = await this.razorpayXPost("/contacts", {
      name: input.recipientName || "Recipient",
      type: "vendor",
      reference_id: `contact_${input.referenceId}`,
      notes: input.notes || {},
    });

    const fundAccount = await this.razorpayXPost("/fund_accounts", {
      contact_id: contact.id,
      account_type: "vpa",
      vpa: {
        address: input.recipientUpiId,
      },
    });

    const payout = await this.razorpayXPost("/payouts", {
      account_number: creds.accountNumber,
      fund_account_id: fundAccount.id,
      amount: input.amountPaise,
      currency: "INR",
      mode: "UPI",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: input.referenceId,
      narration: input.narration,
      notes: input.notes || {},
    });

    return {
      payoutId: String(payout?.id || ""),
      status: String(payout?.status || ""),
      utr: String(payout?.utr || "") || undefined,
      fundAccountId: String(fundAccount?.id || "") || undefined,
      contactId: String(contact?.id || "") || undefined,
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret =
      process.env.RAZORPAYX_WEBHOOK_SECRET ||
      process.env.RAZORPAY_WEBHOOK_SECRET ||
      "";
    if (!secret || !signature || !rawBody?.length) return false;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    return expectedSignature === signature;
  }
}
