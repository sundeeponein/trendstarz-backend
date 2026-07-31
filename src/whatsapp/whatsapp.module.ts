import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { NotificationPreferenceSchema } from "../database/schemas/notification-preference.schema";
import { WhatsAppService } from "./whatsapp.service";
import {
  WhatsAppWebhookController,
  WhatsAppEmbeddedSignupController,
} from "./whatsapp.controller";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "NotificationPreference", schema: NotificationPreferenceSchema },
    ]),
  ],
  controllers: [WhatsAppWebhookController, WhatsAppEmbeddedSignupController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
