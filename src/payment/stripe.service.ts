import { Injectable } from "@nestjs/common";
import Stripe from "stripe";

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
      apiVersion: "2025-11-17.clover",
    });
  }

  async createPaymentIntent(amount: number, currency: string = "inr", metadata?: Record<string, string>) {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount,
      currency,
      ...(metadata ? { metadata } : {}),
    });
    return paymentIntent.client_secret;
  }

  async retrievePaymentIntent(paymentIntentId: string) {
    return await this.stripe.paymentIntents.retrieve(paymentIntentId);
  }
}
