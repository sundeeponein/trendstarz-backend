import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { CampaignInvitesService } from "./campaign-invites.service";

import { UseInterceptors, UploadedFile } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { CloudinaryService } from "../cloudinary.service";

@Controller("campaign-invites")
export class CampaignInvitesController {
  constructor(
    private readonly invitesService: CampaignInvitesService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private requesterId(req: any): string {
    return String(
      req?.user?.userId ||
        req?.user?.sub ||
        req?.user?._id ||
        req?.user?.id ||
        "",
    ).trim();
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/upload-image")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req: any, file: any, cb: any) => {
          const dest = path.resolve(
            process.cwd(),
            "assets/local-images/campaign_proofs",
          );
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          cb(null, dest);
        },
        filename: (req: any, file: any, cb: any) => {
          const ext = path.extname(file.originalname);
          cb(null, randomUUID() + ext);
        },
      }),
      fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
        if (!allowed.includes(file.mimetype)) {
          return cb(
            new BadRequestException("Only JPG, PNG, or WebP images are allowed"),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadCampaignProof(
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    const uploaded = await this.cloudinaryService.uploadImage(
      file.path,
      "campaign_proofs",
    );

    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return {
      url: uploaded.secure_url || uploaded.url,
      public_id: uploaded.public_id,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const brandId = this.requesterId(req);
    return this.invitesService.create(brandId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get("campaign/:campaignId")
  async findByCampaign(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
  ) {
    return this.invitesService.findByCampaign(
      campaignId,
      this.requesterId(req),
      req.user?.role,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get("influencer")
  async findByInfluencer(@Req() req: any, @Query("scope") scope?: string) {
    const influencerId = this.requesterId(req);
    return this.invitesService.findByInfluencer(influencerId, scope);
  }

  @UseGuards(JwtAuthGuard)
  @Get("photographer")
  async findByPhotographer(@Req() req: any) {
    const photographerId = this.requesterId(req);
    return this.invitesService.findByPhotographer(photographerId);
  }

  @UseGuards(JwtAuthGuard)
  @Post("campaign/:campaignId/apply")
  async applyToCampaign(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    const influencerId = this.requesterId(req);
    return this.invitesService.applyToCampaign(
      influencerId,
      campaignId,
      body?.selectedPlatform,
    );
  }

  /** GET /campaign-invites/:id — get a single invite with campaign platform/deliverable info */
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  async findOne(@Param("id") id: string, @Req() req: any) {
    return this.invitesService.findOneWithCampaign(id);
  }

  /**
   * GET /campaign-invites/brand/completed-with/:influencerId
   * Brand uses this to check if they have a completed collaboration
   * with a specific influencer (prerequisite for writing a review).
   */
  @UseGuards(JwtAuthGuard)
  @Get("brand/completed-with/:influencerId")
  async completedWithInfluencer(
    @Param("influencerId") influencerId: string,
    @Req() req: any,
  ) {
    const brandId = this.requesterId(req);
    const invite = await this.invitesService.findCompletedByBrandAndInfluencer(
      brandId,
      influencerId,
    );
    return { invite };
  }

  /** GET /campaign-invites/brand/attention-counts — needs-attention widget */
  @UseGuards(JwtAuthGuard)
  @Get("brand/attention-counts")
  async brandAttentionCounts(@Req() req: any) {
    const brandId = this.requesterId(req);
    return this.invitesService.getBrandAttentionCounts(brandId);
  }

  /** GET /campaign-invites/influencer/attention-counts — influencer needs-attention widget */
  @UseGuards(JwtAuthGuard)
  @Get("influencer/attention-counts")
  async influencerAttentionCounts(@Req() req: any) {
    const influencerId = this.requesterId(req);
    return this.invitesService.getInfluencerAttentionCounts(influencerId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/respond")
  async respond(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      status: "accepted" | "declined" | "counter_sent";
      selectedPostDate?: string;
      selectedPlatform?: string;
      selectedContentType?: string;
      counterAmount?: number;
      counterMessage?: string;
      payout?: {
        upiId?: string;
        mobile?: string;
        accountHolderName?: string;
      };
      shippingAddress?: {
        contactName?: string;
        contactMobile?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        pincode?: string;
        landmark?: string;
      };
    },
  ) {
    const influencerId = this.requesterId(req);
    return this.invitesService.respond(
      id,
      influencerId,
      body.status,
      body.selectedPostDate,
      body.selectedPlatform,
      body.selectedContentType,
      body.counterAmount,
      body.counterMessage,
      body.payout,
      body.shippingAddress,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/counter/respond")
  async respondToCounter(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      action: "accept" | "decline" | "counter";
      note?: string;
      counterAmount?: number;
    },
  ) {
    return this.invitesService.respondToCounter(
      id,
      this.requesterId(req),
      body?.action,
      body?.note,
      body?.counterAmount,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/unlock")
  async unlockContact(@Param("id") id: string, @Req() req: any) {
    const brandId = this.requesterId(req);
    return this.invitesService.unlockContact(id, brandId);
  }

  // ── Fulfillment / brand actions (Slice D) ──────────────────────

  @UseGuards(JwtAuthGuard)
  @Patch(":id/fulfillment/product")
  async updateProductFulfillment(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      courier?: string;
      trackingId?: string;
      trackingUrl?: string;
      shippedAt?: string;
      deliveredAt?: string;
      status?: "pending" | "shipped" | "delivered" | "returned";
      note?: string;
    },
  ) {
    return this.invitesService.updateProductFulfillment(
      id,
      this.requesterId(req),
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/fulfillment/check-in")
  async updateLocationCheckIn(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      status?: "pending" | "checked_in" | "no_show" | "cancelled";
      scheduledAt?: string;
      checkedInAt?: string;
      note?: string;
    },
  ) {
    return this.invitesService.updateLocationCheckIn(
      id,
      this.requesterId(req),
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/due-date")
  async setDueDate(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { dueDate: string | null },
  ) {
    return this.invitesService.setInviteDueDate(
      id,
      this.requesterId(req),
      body?.dueDate ?? null,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/remind")
  async remindInvite(@Param("id") id: string, @Req() req: any) {
    return this.invitesService.remindInvite(id, this.requesterId(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/withdraw")
  async withdrawInvite(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reason?: string },
  ) {
    return this.invitesService.withdrawInvite(
      id,
      this.requesterId(req),
      body?.reason,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/report")
  async reportInviteIssue(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reason: string },
  ) {
    return this.invitesService.reportInviteIssue(
      id,
      this.requesterId(req),
      body?.reason,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/withdraw-dispute")
  async withdrawFromDispute(@Param("id") id: string, @Req() req: any) {
    return this.invitesService.withdrawFromDispute(id, this.requesterId(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/request-admin-review")
  async requestAdminReviewForDispute(@Param("id") id: string, @Req() req: any) {
    return this.invitesService.requestAdminReviewForDispute(id, this.requesterId(req));
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/analytics")
  async submitAnalytics(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reach?: number; engagement?: number; clicks?: number },
  ) {
    const influencerId = this.requesterId(req);
    return this.invitesService.submitAnalytics(id, influencerId, body);
  }

  // ── Submission endpoints ───────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Patch(":id/start-work")
  async startWork(@Param("id") id: string, @Req() req: any) {
    const influencerId = req.user?.userId;
    return this.invitesService.startWork(id, influencerId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(":id/submit")
  async submitPost(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      postUrl: string;
      postType?: string;
      captionUsed?: string;
      postScreenshotUrl?: string;
      insightsScreenshotUrl?: string;
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      reachCount?: number;
    },
  ) {
    const influencerId = req.user?.userId;
    return this.invitesService.submitPost(id, influencerId, body);
  }

  // Local image upload endpoint
  @UseGuards(JwtAuthGuard)
  @UseGuards(JwtAuthGuard)
  @Get(":id/submission")
  async getSubmission(@Param("id") id: string) {
    return this.invitesService.getSubmissionByInvite(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get("campaign/:campaignId/submissions")
  async getCampaignSubmissions(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
  ) {
    const brandId = this.requesterId(req);
    return this.invitesService.getSubmissionsByCampaign(campaignId, brandId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/auto-complete")
  async setSubmissionAutoComplete(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { enabled?: boolean },
  ) {
    const brandId = this.requesterId(req);
    return this.invitesService.setSubmissionAutoComplete(
      id,
      brandId,
      body.enabled === true,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/review")
  async reviewSubmission(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      action: "approve" | "dispute";
      feedback?: string;
      disputeIssueReason?: string;
      disputeReason?: string;
      disputeEvidenceUrl?: string;
    },
  ) {
    const brandId = this.requesterId(req);
    return this.invitesService.reviewSubmission(
      id,
      brandId,
      body.action,
      body.feedback,
      body.disputeReason,
      body.disputeIssueReason,
      body.disputeEvidenceUrl,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/stats")
  async updateStats(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      reachCount?: number;
      insightsScreenshotUrl?: string;
    },
  ) {
    const influencerId = this.requesterId(req);
    return this.invitesService.updateSubmissionStats(id, influencerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/auto-approve-stale")
  async autoApproveStale() {
    return this.invitesService.autoApproveStaleSubmissions();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/auto-cancel-disputes")
  async autoCancelExpiredDisputes() {
    return this.invitesService.autoCancelExpiredDisputes();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/disputes")
  async adminListDisputes(
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    return this.invitesService.adminListDisputes({
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/disputes/count")
  async adminCountOpenDisputes() {
    return this.invitesService.adminCountOpenDisputes();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/:id/resolve-dispute")
  async adminResolveDispute(
    @Param("id") id: string,
    @Body()
    body: { outcome?: "completed" | "withdrawn" | "disputed"; note?: string },
  ) {
    return this.invitesService.adminResolveDispute(id, body || {});
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/disputes/bulk-resolve")
  async adminBulkResolveDisputes(
    @Body()
    body: {
      inviteIds: string[];
      outcome?: "completed" | "withdrawn" | "disputed";
      note?: string;
    },
  ) {
    return this.invitesService.adminBulkResolveDisputes(body?.inviteIds || [], {
      outcome: body?.outcome,
      note: body?.note,
    });
  }
}
