import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { RazorpayWebhookService } from "./razorpay-webhook.service";

/**
 * POST /api/razorpay/webhook — set this URL in Razorpay Dashboard → Webhooks
 * with events payment.captured + order.paid and the same secret as the
 * RAZORPAY_PAYMENTS_WEBHOOK_SECRET env var. The raw body is kept by main.ts
 * (needed for the signature).
 */
@Controller("razorpay")
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(private readonly service: RazorpayWebhookService) {}

  @Post("webhook")
  @HttpCode(200)
  async receive(@Req() req: any, @Headers("x-razorpay-signature") signature: string) {
    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
    const secret = process.env.RAZORPAY_PAYMENTS_WEBHOOK_SECRET || "";
    if (!RazorpayWebhookService.signatureValid(raw, signature, secret)) {
      this.logger.warn("Razorpay webhook with an invalid signature (or secret not set) — refused");
      throw new UnauthorizedException("Invalid signature");
    }
    const event = JSON.parse(raw.toString("utf8"));
    // Errors propagate (5xx) so Razorpay retries; completions are once-per-order.
    const result = await this.service.handle(event);
    if (result.outcome !== "ignored") {
      this.logger.log(`Razorpay ${event?.event} order ${result.orderId}: ${result.outcome}`);
    }
    return { received: true, ...result };
  }
}
