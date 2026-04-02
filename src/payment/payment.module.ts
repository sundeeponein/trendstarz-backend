import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { RazorpayService } from "./razorpay.service";
import { PaymentSchema } from "../database/schemas/payment.schema";
import {
  InfluencerSchema,
  BrandSchema,
} from "../database/schemas/profile.schemas";
import { PlansModule } from "../plans/plans.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
    ]),
    PlansModule,
  ],
  controllers: [PaymentController],
  providers: [PaymentService, RazorpayService],
  exports: [PaymentService],
})
export class PaymentModule {}
