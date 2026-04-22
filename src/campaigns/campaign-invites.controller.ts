import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { CampaignInvitesService } from "./campaign-invites.service";

import { UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

@Controller("campaign-invites")
export class CampaignInvitesController {
  constructor(private readonly invitesService: CampaignInvitesService) {}

  @UseGuards(JwtAuthGuard)
  @Post(":id/upload-image")
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (req: any, file: any, cb: any) => {
        const dest = path.join(__dirname, '../assets/local-images/campaign_proofs');
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        cb(null, dest);
      },
      filename: (req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
      },
    }),
  }))
  async uploadCampaignProof(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any
  ) {
    // Return the local URL for the uploaded file
    const filename = file.filename;
    const url = `/assets/local-images/campaign_proofs/${filename}`;
    return { url };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const brandId = req.user?.userId;
    return this.invitesService.create(brandId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get("campaign/:campaignId")
  async findByCampaign(@Param("campaignId") campaignId: string) {
    return this.invitesService.findByCampaign(campaignId);
  }

  @UseGuards(JwtAuthGuard)
  @Get("influencer")
  async findByInfluencer(@Req() req: any) {
    const influencerId = req.user?.userId;
    return this.invitesService.findByInfluencer(influencerId);
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
    const brandId = req.user?.userId;
    const invite = await this.invitesService.findCompletedByBrandAndInfluencer(
      brandId,
      influencerId,
    );
    return { invite };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/respond")
  async respond(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      status: "accepted" | "declined";
      selectedPostDate?: string;
      selectedPlatform?: string;
      selectedContentType?: string;
    },
  ) {
    const influencerId = req.user?.userId;
    return this.invitesService.respond(
      id,
      influencerId,
      body.status,
      body.selectedPostDate,
      body.selectedPlatform,
      body.selectedContentType,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/analytics")
  async submitAnalytics(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reach?: number; engagement?: number; clicks?: number },
  ) {
    const influencerId = req.user?.userId;
    return this.invitesService.submitAnalytics(id, influencerId, body);
  }

  // ── Submission endpoints ───────────────────────────────────────
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
      postScreenshotUrl: string;
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
    const brandId = req.user?.userId;
    return this.invitesService.getSubmissionsByCampaign(campaignId, brandId);
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
      disputeReason?: string;
    },
  ) {
    const brandId = req.user?.userId;
    return this.invitesService.reviewSubmission(
      id,
      brandId,
      body.action,
      body.feedback,
      body.disputeReason,
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
    const influencerId = req.user?.userId;
    return this.invitesService.updateSubmissionStats(id, influencerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/auto-approve-stale")
  async autoApproveStale() {
    return this.invitesService.autoApproveStaleSubmissions();
  }
}
