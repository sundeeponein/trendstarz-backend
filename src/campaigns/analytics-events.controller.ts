import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AnalyticsEventsService } from "./analytics-events.service";

@Controller("analytics")
export class AnalyticsEventsController {
  constructor(private readonly analyticsEventsService: AnalyticsEventsService) {}

  // Campaign funnel events come from signed-in hosts. The user is taken from
  // the login token (the body's userId used to be trusted, with no login).
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post("events")
  async ingest(@Body() body: { events?: any[] }, @Req() req: any) {
    return this.analyticsEventsService.ingestEvents(body || {}, {
      userId: String(req?.user?.userId || ""),
      role: String(req?.user?.role || ""),
    });
  }
}
