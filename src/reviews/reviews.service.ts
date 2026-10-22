import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../plans/plans.service";

/** Work is finished: the post was approved (payout released → "approved") or the collaboration completed. */
export const HOST_REVIEWABLE_INVITE_STATUSES = ["completed", "approved"];
export const REVIEW_COMMENT_MAX_LENGTH = 1000;

/** A creator can review the host once paid, through to the end of the collaboration. */
export const CREATOR_REVIEWABLE_INVITE_STATUSES = [
  "payment_confirmed",
  "working",
  "submitted",
  "completed",
  "approved",
];

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel("Review") private readonly reviewModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    private readonly plansService: PlansService,
  ) {}

  /** Old invites without recipientRole: is the creator a photographer account? */
  private async isPhotographerAccount(id: unknown): Promise<boolean> {
    const photographers = (this.brandModel as any)?.db?.collection?.("photographers");
    if (!photographers) return false;
    return (await photographers.countDocuments({ _id: id }, { limit: 1 })) > 0;
  }

  async writeReview(
    reviewerId: string,
    reviewerType: "brand" | "influencer" | "photographer",
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
    const rating = Number(data.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException("Rating must be a whole number of stars from 1 to 5");
    }
    const comment = typeof data.comment === "string" ? data.comment.trim() : "";
    if (comment.length > REVIEW_COMMENT_MAX_LENGTH) {
      throw new BadRequestException(
        `Please keep the review under ${REVIEW_COMMENT_MAX_LENGTH} characters`,
      );
    }

    const invite = (await this.inviteModel
      .findById(data.inviteId)
      .lean()) as any;
    if (!invite) throw new NotFoundException("Invite not found");

    // The reviewer's SIDE comes from the invite, not their account type: a
    // photographer can be the host (their own collaboration) or the creator
    // (invited by a brand).
    const isHost = String(invite.brandId) === reviewerId;
    const isCreator = String(invite.influencerId) === reviewerId;
    if (!isHost && !isCreator) {
      throw new BadRequestException("This invite does not belong to you");
    }
    if (isHost) {
      if (!HOST_REVIEWABLE_INVITE_STATUSES.includes(invite.status)) {
        throw new BadRequestException(
          "Reviews can only be written after the campaign is completed",
        );
      }
    } else {
      if (!CREATOR_REVIEWABLE_INVITE_STATUSES.includes(invite.status)) {
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

    const targetId = isHost
      ? String(invite.influencerId)
      : String(invite.brandId);

    let targetType: "brand" | "influencer" | "photographer";
    if (isHost) {
      // The creator: photographer or influencer (recipientRole is stored since
      // 2026-10-18; older invites fall back to where the account lives).
      targetType =
        invite.recipientRole === "photographer" ||
        (!invite.recipientRole && (await this.isPhotographerAccount(invite.influencerId)))
          ? "photographer"
          : "influencer";
    } else {
      const ownerId = String(invite.brandId || "");
      const brandExists = ownerId
        ? await this.brandModel.exists({ _id: ownerId })
        : true;
      targetType = brandExists ? "brand" : "photographer";
    }

    let review: any;
    try {
      review = await this.reviewModel.create({
        reviewerId,
        reviewerType,
        targetId,
        targetType,
        campaignId: String(invite.campaignId),
        inviteId: data.inviteId,
        rating,
        comment,
        status: "pending",
      });
    } catch (err: any) {
      // uniq_review_per_invite_side (cron/uniqueConstraints.js) caught a double submit.
      if (err?.code === 11000) {
        throw new BadRequestException(
          "You have already submitted a review for this campaign",
        );
      }
      throw err;
    }

    return { success: true, review };
  }

  async getReviewsForTarget(targetId: string, requesterId: string) {
    // Premium (canReadReviews) or the target itself can see reviews
    const canRead =
      String(requesterId) === String(targetId) ||
      (await this.plansService.checkFeature(requesterId, "canReadReviews"));
    if (!canRead) {
      throw new ForbiddenException(
        "Upgrade to a premium plan to view reviews.",
      );
    }

    const reviews = await this.reviewModel
      // The moderator's note stays with admins.
      .find({ targetId, status: "approved" }, "-adminNote")
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
