import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PushSubscriptionSchema } from "../database/schemas/push-subscription.schema";
import { NotificationPreferenceSchema } from "../database/schemas/notification-preference.schema";
import { PushService } from "./push.service";
import { PushController } from "./push.controller";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "PushSubscription", schema: PushSubscriptionSchema },
      { name: "NotificationPreference", schema: NotificationPreferenceSchema },
    ]),
  ],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
