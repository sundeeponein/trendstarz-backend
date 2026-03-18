/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  invited: ["accepted", "declined"],
  accepted: ["submitted"],
  submitted: ["completed"],
};

@Injectable()
export class CampaignInvitesService {
  constructor(
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
  ) {}

  /** Brand sends an invite to an influencer for a campaign */
  async createInvite(
    campaignId: string,
    influencerId: string,
    brandUserId: string,
  ) {
    // Verify campaign exists and belongs to brand
    const campaign = (await this.campaignModel
      .findById(campaignId)
      .lean()) as any;
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== String(brandUserId)) {
      throw new ForbiddenException("You do not own this campaign");
    }

    // Verify influencer exists
    const influencer = await this.influencerModel
      .findById(influencerId)
      .select("_id")
      .lean();
    if (!influencer) throw new NotFoundException("Influencer not found");

    // Check for duplicate invite
    const existing = await this.inviteModel
      .findOne({ campaignId, influencerId })
      .lean();
    if (existing) {
      throw new BadRequestException(
        "Influencer has already been invited to this campaign",
      );
    }

    const invite = await this.inviteModel.create({
      campaignId: new Types.ObjectId(campaignId),
      influencerId: new Types.ObjectId(influencerId),
      brandId: new Types.ObjectId(brandUserId),
      status: "invited",
      invitedAt: new Date(),
    });

    // Increment the applicants counter on the campaign
    await this.campaignModel.findByIdAndUpdate(campaignId, {
      $inc: { applicants: 1 },
    });

    return invite;
  }

  /** Influencer responds (accept / decline) */
  async respond(inviteId: string, influencerUserId: string, accept: boolean) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== String(influencerUserId)) {
      throw new ForbiddenException("This invite does not belong to you");
    }

    const newStatus = accept ? "accepted" : "declined";
    this.assertTransition(invite.status, newStatus);

    invite.status = newStatus;
    invite.respondedAt = new Date();
    await invite.save();
    return invite;
  }

  /** Influencer submits content for a campaign */
  async submit(
    inviteId: string,
    influencerUserId: string,
    url: string,
    notes?: string,
  ) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== String(influencerUserId)) {
      throw new ForbiddenException("This invite does not belong to you");
    }

    this.assertTransition(invite.status, "submitted");

    invite.status = "submitted";
    invite.submission = {
      url,
      notes: notes || "",
      submittedAt: new Date(),
    };
    await invite.save();
    return invite;
  }

  /** Brand marks a submission as completed */
  async markCompleted(inviteId: string, brandUserId: string) {
    const invite = await this.inviteModel.findById(inviteId);
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.brandId) !== String(brandUserId)) {
      throw new ForbiddenException(
        "You do not own the campaign for this invite",
      );
    }

    this.assertTransition(invite.status, "completed");

    invite.status = "completed";
    await invite.save();
    return invite;
  }

  /** Get all invites for a campaign (brand view) */
  async getInvitesForCampaign(campaignId: string, brandUserId: string) {
    const campaign = (await this.campaignModel
      .findById(campaignId)
      .lean()) as any;
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== String(brandUserId)) {
      throw new ForbiddenException("You do not own this campaign");
    }

    return this.inviteModel
      .find({ campaignId: new Types.ObjectId(campaignId) })
      .populate("influencerId", "name username profileImages socialMedia")
      .sort({ createdAt: -1 })
      .lean();
  }

  /** Get all invites for the logged-in influencer */
  async getInvitesForInfluencer(influencerUserId: string, status?: string) {
    const filter: any = {
      influencerId: new Types.ObjectId(influencerUserId),
    };
    if (status) filter.status = status;

    return this.inviteModel
      .find(filter)
      .populate(
        "campaignId",
        "title description image status budgetMin budgetMax timelineStart timelineEnd",
      )
      .populate("brandId", "brandName brandLogo")
      .sort({ createdAt: -1 })
      .lean();
  }

  // ── Private helpers ──────────────────────
  private assertTransition(current: string, next: string) {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.includes(next)) {
      throw new BadRequestException(
        `Cannot transition from "${current}" to "${next}"`,
      );
    }
  }
}
