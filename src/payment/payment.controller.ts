import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaymentService } from './payment.service';
import { StripeService } from './stripe.service';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly stripeService: StripeService
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('create')
  async createPayment(@Body() body: { userId: string; amount: number; method: string }) {
    return this.paymentService.createPayment(body.userId, body.amount, body.method);
  }

  @UseGuards(JwtAuthGuard)
  @Post('create-intent')
  async createPaymentIntent(@Body() body: { amount: number; currency?: string }) {
    const clientSecret = await this.stripeService.createPaymentIntent(body.amount, body.currency || 'inr');
    return { clientSecret };
  }
}
