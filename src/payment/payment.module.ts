import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { RazorpayService } from "./razorpay.service";
import { PaymentSchema } from "../database/schemas/payment.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
    ]),
  ],
  controllers: [PaymentController],
  providers: [PaymentService, RazorpayService],
  exports: [PaymentService],
})
export class PaymentModule {}
