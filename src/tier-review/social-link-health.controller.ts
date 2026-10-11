import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { SocialLinkHealthService } from "./social-link-health.service";

/** Social links that keep working: broken-link reports + the creator's 90-day check. */
@Controller()
@UseGuards(JwtAuthGuard)
export class SocialLinkHealthController {
  constructor(private readonly service: SocialLinkHealthService) {}

  private user(req: any) {
    return {
      userId: String(req?.user?.userId || req?.user?.sub || ""),
      role: String(req?.user?.role || ""),
    };
  }

  /** A signed-in user (usually a host) reports that a creator's link doesn't open. */
  @Post("social-links/report")
  report(
    @Req() req: any,
    @Body()
    body: {
      profileType?: string;
      profileId?: string;
      socialAccountId?: string;
    },
  ) {
    return this.service.reportBrokenLink(this.user(req), body || {});
  }

  /** Which links of a profile are reported as not opening ("may be outdated"). */
  @Get("social-links/status/:profileType/:profileId")
  status(
    @Param("profileType") profileType: string,
    @Param("profileId") profileId: string,
  ) {
    return this.service.linkStatus(profileType, profileId);
  }

  /** Admin confirms (→ re-review) or dismisses a broken-link report. */
  @UseGuards(RolesGuard)
  @Post("admin/social-links/resolve")
  resolve(
    @Req() req: any,
    @Body()
    body: {
      profileType?: string;
      profileId?: string;
      socialAccountId?: string;
      action?: string;
      note?: string;
    },
  ) {
    return this.service.resolveLinkReport(req.user, body || {});
  }

  /** Admin: creators with an open broken-link report, per profile type. */
  @UseGuards(RolesGuard)
  @Get("admin/social-links/open-count")
  openCount() {
    return this.service.openReportCounts();
  }

  /** The creator's own 90-day "are these still your accounts?" check. */
  @Get("creator/social-confirm")
  confirmStatus(@Req() req: any) {
    return this.service.confirmStatus(this.user(req));
  }

  @Post("creator/social-confirm")
  confirm(@Req() req: any) {
    return this.service.confirmHandles(this.user(req));
  }
}
