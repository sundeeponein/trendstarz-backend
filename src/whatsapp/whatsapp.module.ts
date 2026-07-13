import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { NotificationPreferenceSchema } from "../database/schemas/notification-preference.schema";
import { WhatsAppService } from "./whatsapp.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "NotificationPreference", schema: NotificationPreferenceSchema },
    ]),
  ],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
