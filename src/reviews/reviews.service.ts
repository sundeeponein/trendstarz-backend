import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel("Review") private readonly reviewModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

  async writeReview(
    reviewerId: string,
    reviewerType: "brand" | "influencer",
    data: { inviteId: string; rating: number; comment?: string },
  ) {
    // Gate: premium canWriteReview feature
    const canWrite = await this.plansService.checkFeature(
      reviewerId,
      "canWriteReview",
    );
    if (!canWrite) {
      throw new ForbiddenException(
        "Upgrade to a premium plan to write reviews.",
      );
    }

    if (!data.inviteId) throw new BadRequestException("inviteId is required");
    if (!data.rating || data.rating < 1 || data.rating > 5) {
      throw new BadRequestException("Rating must be between 1 and 5");
    }

    const invite = (await this.inviteModel.findById(data.inviteId).lean()) as any;
    if (!invite) throw new NotFoundException("Invite not found");

    if (reviewerType === "brand") {
      if (String(invite.brandId) !== reviewerId) {
        throw new BadRequestException("This invite does not belong to you");
      }
      if (invite.status !== "completed") {
        throw new BadRequestException(
          "Reviews can only be written after the campaign is completed",
        );
      }
    } else {
      if (String(invite.influencerId) !== reviewerId) {
        throw new BadRequestException("This invite does not belong to you");
      }
      if (!["completed", "payment_confirmed"].includes(invite.status)) {
        throw new BadRequestException(
          "Reviews can only be written after payment is confirmed or campaign is completed",
        );
      }
    }

    // Prevent duplicate review for the same invite + reviewer type
    const existing = await this.reviewModel
      .findOne({ inviteId: data.inviteId, reviewerType })
      .lean();
    if (existing) {
      throw new BadRequestException(
        "You have already submitted a review for this campaign",
      );
    }

    const targetId =
      reviewerType === "brand"
        ? String(invite.influencerId)
        : String(invite.brandId);
    const targetType = reviewerType === "brand" ? "influencer" : "brand";

    const review = await this.reviewModel.create({
      reviewerId,
      reviewerType,
      targetId,
      targetType,
      campaignId: String(invite.campaignId),
      inviteId: data.inviteId,
      rating: data.rating,
      comment: data.comment || "",
      status: "pending",
    });

    return { success: true, review };
  }

  async getReviewsForTarget(targetId: string, requesterId: string) {
    // Only premium influencers (canReadReviews) or the target itself can see reviews
    const canRead = await this.plansService.checkFeature(
      requesterId,
      "canReadReviews",
    );
    if (!canRead) {
      throw new ForbiddenException(
        "Upgrade to a premium plan to view reviews.",
      );
    }

    const reviews = await this.reviewModel
      .find({ targetId, status: "approved" })
      .sort({ createdAt: -1 })
      .lean();

    return { success: true, reviews };
  }

  async getMyWrittenReviews(reviewerId: string) {
    const reviews = await this.reviewModel
      .find({ reviewerId })
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, reviews };
  }

  /* ── Admin ── */

  async getPendingReviews() {
    const reviews = await this.reviewModel
      .find({ status: "pending" })
      .sort({ createdAt: 1 })
      .lean();
    return { success: true, reviews };
  }

  async adminDecide(
    reviewId: string,
    action: "approved" | "rejected",
    adminNote?: string,
  ) {
    const review = await this.reviewModel.findById(reviewId);
    if (!review) throw new NotFoundException("Review not found");
    review.status = action;
    if (adminNote) review.adminNote = adminNote;
    await review.save();
    return { success: true, review };
  }
}
