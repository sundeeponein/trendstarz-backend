import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PlatformEventSchema } from "../database/schemas/platform-event.schema";
import { PlatformEventsService } from "./platform-events.service";

/**
 * Internal-only: no controller. PlatformEvents are created by trusted backend
 * services, never by a client request.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "PlatformEvent",
        schema: PlatformEventSchema,
        collection: "platform_events",
      },
    ]),
  ],
  providers: [PlatformEventsService],
  exports: [PlatformEventsService],
})
export class PlatformEventsModule {}
