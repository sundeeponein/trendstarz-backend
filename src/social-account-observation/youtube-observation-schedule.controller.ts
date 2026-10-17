import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { YoutubeObservationSchedulerService } from "./youtube-observation-scheduler.service";

/**
 * Stage 3D-1a — scheduled YouTube observation status. Admin/subadmin only,
 * read-only: shows the switch, the rules, what is due or paused and the
 * retention backlog. It never triggers an observation.
 */
@Controller("admin/social-observation")
@UseGuards(JwtAuthGuard, RolesGuard)
export class YoutubeObservationScheduleController {
  constructor(private readonly scheduler: YoutubeObservationSchedulerService) {}

  @Get("youtube-schedule")
  status() {
    return this.scheduler.status();
  }
}
