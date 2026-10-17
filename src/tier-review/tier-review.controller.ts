import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { TierReviewService } from "./tier-review.service";

/**
 * Stage 3D-1b — tier review queue. Admin/subadmin only, read-only. Decide with
 * PATCH admin/users/:type/:id/social-accounts/:socialAccountId/tier-verification.
 */
@Controller("admin/tier-review")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TierReviewController {
  constructor(private readonly service: TierReviewService) {}

  @Get()
  getQueue(
    @Query("reason") reason?: string,
    @Query("platform") platform?: string,
    @Query("profileType") profileType?: string,
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.service.getQueue({
      reason,
      platform,
      profileType,
      q,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 25,
    });
  }
}
