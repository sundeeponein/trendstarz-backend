import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(@Req() req: any, @Query("limit") limit?: string) {
    const userId: string = req.user?.userId || req.user?.sub;
    const items = await this.notificationsService.listForUser(
      userId,
      Number(limit || 20),
    );
    return { success: true, data: items };
  }

  @Get("unread-count")
  async unreadCount(@Req() req: any) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.notificationsService.unreadCount(userId);
  }

  @Patch(":id/read")
  async markRead(@Req() req: any, @Param("id") id: string) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.notificationsService.markRead(userId, id);
  }

  @Post("mark-all-read")
  async markAllRead(@Req() req: any) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.notificationsService.markAllRead(userId);
  }
}
