import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { CollaborationRecordService } from "./collaboration-record.service";

@Controller("collaboration-record")
export class CollaborationRecordController {
  constructor(private readonly service: CollaborationRecordService) {}

  /** GET /collaboration-record/me — the signed-in owner's own record */
  @UseGuards(JwtAuthGuard)
  @Get("me")
  async mine(@Req() req: any) {
    const record = await this.service.forUser(String(req.user?.userId || ""), req.user?.role);
    return { success: true, ...record };
  }

  /** GET /collaboration-record/admin/list?side=creator|host — everyone's record (admin page) */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/list")
  list(@Query("side") side: string) {
    return this.service.listAll(side);
  }

  /** GET /collaboration-record/admin/:role/:id — any user's record (admin) */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/:role/:id")
  async forAdmin(@Param("role") role: string, @Param("id") id: string) {
    const record = await this.service.forUser(id, role);
    return { success: true, ...record };
  }
}
