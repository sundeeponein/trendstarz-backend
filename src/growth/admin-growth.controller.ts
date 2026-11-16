import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { LogAdminAction } from "../utils/admin-action.interceptor";
import { GrowthService } from "./growth.service";

/** Admin → Growth: scorecard, shortlist requests, unanswered invites. */
@Controller("admin/growth")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminGrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Get("scorecard")
  async scorecard() {
    return this.growth.scorecard();
  }

  @Get("summary")
  async summary() {
    return this.growth.summary();
  }

  @Get("unanswered-invites")
  async unanswered() {
    return this.growth.unansweredInvites();
  }

  @Get("shortlist-requests")
  async list(@Query("status") status?: string) {
    return this.growth.listRequests(status);
  }

  @Patch("shortlist-requests/:id")
  @LogAdminAction("shortlist_request_update")
  async update(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return this.growth.updateRequest(id, body, String(req?.user?.userId || ""));
  }
}
