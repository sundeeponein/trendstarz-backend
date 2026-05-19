import { Body, Controller, Post } from "@nestjs/common";
import { AnalyticsEventsService } from "./analytics-events.service";

@Controller("analytics")
export class AnalyticsEventsController {
  constructor(private readonly analyticsEventsService: AnalyticsEventsService) {}

  @Post("events")
  async ingest(@Body() body: { events?: any[] }) {
    return this.analyticsEventsService.ingestEvents(body || {});
  }
}
