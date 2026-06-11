import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ProfileVerificationService } from "./profile-verification.service";

type AdminUserType = "Influencer" | "Brand" | "Photographer" | "User";

@Controller()
export class ProfileVerificationController {
  constructor(private readonly service: ProfileVerificationService) {}

  private requesterId(req: any): string {
    return String(req?.user?.userId || req?.user?.sub || req?.user?.id || "").trim();
  }

  @UseGuards(JwtAuthGuard)
  @Get("profile-verification/me")
  getMyDashboard(@Req() req: any) {
    return this.service.getDashboard(this.requesterId(req), req?.user?.role);
  }

  @UseGuards(JwtAuthGuard)
  @Post("profile-verification/resubmit")
  resubmit(@Req() req: any) {
    return this.service.resubmit(this.requesterId(req), req?.user?.role);
  }

  @UseGuards(JwtAuthGuard)
  @Get("profile-verification/eligibility")
  async eligibility(@Req() req: any) {
    const dashboard = await this.service.getDashboard(this.requesterId(req), req?.user?.role);
    return dashboard.campaignEligibility;
  }

  @UseGuards(JwtAuthGuard)
  @Get("admin/profile-moderation")
  listModeration(@Req() req: any, @Query() query: any) {
    return this.service.listModeration(req?.user, query);
  }

  @UseGuards(JwtAuthGuard)
  @Get("admin/profile-moderation/:userType/:userId")
  adminDetail(
    @Req() req: any,
    @Param("userType") userType: AdminUserType,
    @Param("userId") userId: string,
  ) {
    return this.service.adminDetail(req?.user, userType, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post("admin/profile-moderation/:userType/:userId/action")
  adminAction(
    @Req() req: any,
    @Param("userType") userType: AdminUserType,
    @Param("userId") userId: string,
    @Body() body: any,
  ) {
    return this.service.adminAction(req?.user, userType, userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("admin/profile-moderation/:userType/:userId/checks")
  updateVerificationChecks(
    @Req() req: any,
    @Param("userType") userType: AdminUserType,
    @Param("userId") userId: string,
    @Body() body: any,
  ) {
    return this.service.updateVerificationChecks(req?.user, userType, userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post("admin/profile-moderation/:userType/:userId/flags")
  addFlag(
    @Req() req: any,
    @Param("userType") userType: AdminUserType,
    @Param("userId") userId: string,
    @Body() body: any,
  ) {
    return this.service.addFlag(req?.user, userType, userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("admin/profile-moderation/flags/:flagId")
  updateFlag(@Req() req: any, @Param("flagId") flagId: string, @Body() body: any) {
    return this.service.updateFlag(req?.user, flagId, body);
  }
}
