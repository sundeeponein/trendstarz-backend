import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { NotificationPreferenceSchema } from "../database/schemas/notification-preference.schema";
import {
  InfluencerSchema,
  BrandSchema,
  PhotographerSchema,
} from "../database/schemas/profile.schemas";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppLifecycleService } from "./whatsapp-lifecycle.service";
import {
  WhatsAppWebhookController,
  WhatsAppEmbeddedSignupController,
} from "./whatsapp.controller";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "NotificationPreference", schema: NotificationPreferenceSchema },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Photographer", schema: PhotographerSchema, collection: "photographers" },
    ]),
  ],
  controllers: [WhatsAppWebhookController, WhatsAppEmbeddedSignupController],
  providers: [WhatsAppService, WhatsAppLifecycleService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
