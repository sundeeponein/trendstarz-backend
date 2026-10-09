import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { PushModule } from "../push/push.module";
import { AvailabilityExpiryService } from "./availability-expiry.service";

/** Option B (3D-1d): ends "not available" periods and reminds the creator. */
@Module({
  imports: [NotificationsModule, PushModule],
  providers: [AvailabilityExpiryService],
})
export class AvailabilityModule {}
