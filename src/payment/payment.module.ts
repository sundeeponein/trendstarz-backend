import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { RazorpayService } from "./razorpay.service";
import { PaymentSchema } from "../database/schemas/payment.schema";
import {
  InfluencerSchema,
  BrandSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { PlansModule } from "../plans/plans.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PushModule } from "../push/push.module";
import { LinkConversionSchema } from "../database/schemas/link-conversion.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Photographer", schema: PhotographerSchema, collection: "photographers" },
      { name: "LinkConversion", schema: LinkConversionSchema, collection: "linkconversions" },
    ]),
    PlansModule,
    NotificationsModule,
    PushModule,
  ],
  controllers: [PaymentController],
  providers: [PaymentService, RazorpayService],
  exports: [PaymentService],
})
export class PaymentModule {}
