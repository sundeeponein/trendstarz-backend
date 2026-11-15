import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { recordAdminAction } from "../utils/admin-action-log.util";
import { ReactivationEmailService } from "./reactivation-email.service";

/**
 * Matching 3E (2026-11-15) — the reactivation email to creators not seen in
 * 90+ days. Nothing is sent until an admin presses Send; each creator gets it
 * at most once.
 */
@Controller("admin/matching/reactivation-email")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReactivationEmailController {
  constructor(private readonly service: ReactivationEmailService) {}

  /** GET — how many would get it, how many already did, the rendered email and send progress. */
  @Get()
  preview() {
    return this.service.preview();
  }

  /** POST /test — one copy to the given address. */
  @Post("test")
  async test(@Body() body: any, @Req() req: any) {
    const result = await this.service.sendTest(body?.to);
    await recordAdminAction(req, "reactivation_email_test", { type: "email", id: "reactivation" }, { to: result.to });
    return result;
  }

  /** POST /send — starts sending to dormant creators who haven't had it yet (up to `limit`). */
  @Post("send")
  async send(@Body() body: any, @Req() req: any) {
    const result = await this.service.sendAll(body?.limit);
    await recordAdminAction(req, "reactivation_email_send", { type: "email", id: "reactivation" }, { limit: result.limit });
    return result;
  }
}
