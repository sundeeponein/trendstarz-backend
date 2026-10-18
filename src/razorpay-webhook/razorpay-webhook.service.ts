import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { createHmac, timingSafeEqual } from "crypto";
import { MonetizationService } from "../monetization/monetization.service";
import { CollaborationScoreService } from "../collaboration-score/collaboration-score.service";
import { PaymentsPayoutsService } from "../payments-payouts/payments-payouts.service";
import { paymentAmountPaise } from "../payment/payment-amount.util";

/** Razorpay events this endpoint acts on (both mean "the order was paid"). */
export const HANDLED_EVENTS = ["payment.captured", "order.paid"];

export type WebhookOutcome =
  | "completed"
  | "already_completed"
  | "ignored"
  | "unknown_order"
  | "amount_mismatch";

/**
 * Razorpay → TrendStarZ "this order was paid". The checkout page normally
 * confirms a payment itself; this is the server-side backup for when the
 * user's browser never comes back (closed tab, lost connection) — Razorpay
 * has the money, so the purchase must still be activated. Every completion is
 * once-per-order, so the page and the webhook can both arrive safely.
 */
@Injectable()
export class RazorpayWebhookService {
  private readonly logger = new Logger(RazorpayWebhookService.name);

  constructor(
    @InjectModel("Payment") private readonly paymentModel: Model<any>,
    @InjectModel("CampaignTransaction") private readonly transactionModel: Model<any>,
    private readonly monetization: MonetizationService,
    private readonly collaborationScore: CollaborationScoreService,
    private readonly payouts: PaymentsPayoutsService,
  ) {}

  /** HMAC-SHA256 of the exact request bytes with the webhook secret. */
  static signatureValid(rawBody: Buffer, signature: string, secret: string): boolean {
    if (!secret || !signature || !rawBody?.length) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handle(event: any): Promise<{ outcome: WebhookOutcome; orderId?: string }> {
    const type = String(event?.event || "");
    if (!HANDLED_EVENTS.includes(type)) return { outcome: "ignored" };
    const payment = event?.payload?.payment?.entity || {};
    const order = event?.payload?.order?.entity || {};
    const orderId = String(payment.order_id || order.id || "").trim();
    const paymentId = String(payment.id || "").trim();
    const amountPaise = Number(payment.amount ?? order.amount_paid ?? NaN);
    if (!orderId || !paymentId) return { outcome: "ignored" };
    if (payment.status && payment.status !== "captured") return { outcome: "ignored", orderId };

    // 1) Premium / invite unlock / re-analysis — one row in `payments` per order.
    const row: any = await this.paymentModel
      .findOne({ orderId })
      .select("purpose status amount amountPaise gatewayProvider paymentMethod")
      .lean();
    if (row) {
      if (row.status === "approved") return { outcome: "already_completed", orderId };
      if (Number.isFinite(amountPaise) && amountPaise !== paymentAmountPaise(row)) {
        this.logger.error(
          `Razorpay order ${orderId}: paid ${amountPaise} ≠ expected ${paymentAmountPaise(row)} — not activated`,
        );
        return { outcome: "amount_mismatch", orderId };
      }
      if (row.purpose === "collab_score_reanalysis") {
        const done = await this.collaborationScore.completeReanalysisOrder({ orderId, paymentId });
        return { outcome: done ? "completed" : "already_completed", orderId };
      }
      if (row.purpose === "subscription" || row.purpose === "invite_unlock") {
        await this.monetization.completePaidOrder({ orderId, paymentId, purpose: row.purpose });
        return { outcome: "completed", orderId };
      }
      return { outcome: "ignored", orderId };
    }

    // 2) Campaign payments — rows in `campaigntransactions` for this order.
    const campaignRows = await this.transactionModel.countDocuments({
      $or: [{ paymentBatchId: orderId }, { gatewayOrderIds: orderId }],
      gateway: "razorpay",
    });
    if (campaignRows) {
      try {
        await this.payouts.completeCampaignOrder({
          orderId,
          paymentId,
          paidAmountPaise: Number.isFinite(amountPaise) ? amountPaise : undefined,
        });
      } catch (err: any) {
        if (/mismatch/i.test(String(err?.message))) return { outcome: "amount_mismatch", orderId };
        throw err;
      }
      return { outcome: "completed", orderId };
    }

    this.logger.warn(`Razorpay webhook for unknown order ${orderId} (payment ${paymentId})`);
    return { outcome: "unknown_order", orderId };
  }
}
