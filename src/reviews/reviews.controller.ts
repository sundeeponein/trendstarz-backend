import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { ReviewsService } from "./reviews.service";

@Controller("reviews")
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /** POST /reviews — write a review (premium only) */
  @UseGuards(JwtAuthGuard)
  @Post()
  async writeReview(
    @Req() req: any,
    @Body() body: { inviteId: string; rating: number; comment?: string },
  ) {
    const { userId, role } = req.user;
    if (!userId) throw new BadRequestException("Not authenticated");
    const reviewerType =
      role === "BRAND" || role === "brand" ? "brand" : "influencer";
    return this.reviewsService.writeReview(userId, reviewerType, body);
  }

  /** GET /reviews/target/:targetId — approved reviews for a target (premium canReadReviews) */
  @UseGuards(JwtAuthGuard)
  @Get("target/:targetId")
  async getForTarget(@Param("targetId") targetId: string, @Req() req: any) {
    const { userId } = req.user;
    if (!userId) throw new BadRequestException("Not authenticated");
    return this.reviewsService.getReviewsForTarget(targetId, userId);
  }

  /** GET /reviews/my — reviews I have written */
  @UseGuards(JwtAuthGuard)
  @Get("my")
  async myReviews(@Req() req: any) {
    const { userId } = req.user;
    if (!userId) throw new BadRequestException("Not authenticated");
    return this.reviewsService.getMyWrittenReviews(userId);
  }

  /** GET /reviews/admin/pending — admin: all reviews awaiting approval */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/pending")
  getPending() {
    return this.reviewsService.getPendingReviews();
  }

  /** PATCH /reviews/admin/:id — admin approve or reject */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch("admin/:id")
  adminDecide(
    @Param("id") id: string,
    @Body() body: { action: "approved" | "rejected"; adminNote?: string },
  ) {
    if (!["approved", "rejected"].includes(body.action)) {
      throw new BadRequestException('action must be "approved" or "rejected"');
    }
    return this.reviewsService.adminDecide(id, body.action, body.adminNote);
  }
}
