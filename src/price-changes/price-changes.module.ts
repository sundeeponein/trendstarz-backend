import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { PushModule } from "../push/push.module";
import {
  AdminPriceChangesController,
  CreatorPendingPricesController,
} from "./price-changes.controller";
import { PriceChangesService } from "./price-changes.service";

@Module({
  imports: [NotificationsModule, PushModule],
  controllers: [AdminPriceChangesController, CreatorPendingPricesController],
  providers: [PriceChangesService],
  exports: [PriceChangesService],
})
export class PriceChangesModule {}
