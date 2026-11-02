import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { buildFollowUp, InviteFollowUp } from "./invite-follow-up.util";

/**
 * When a creator opened an invite, and when a host opened their campaign's
 * responses — admin-only follow-up data. Kept in its own collection (never on
 * the invite), so no host/creator endpoint can leak it as a read receipt.
 *   { kind: "invite", targetId: inviteId, userId, firstAt, lastAt, count }
 *   { kind: "campaign", targetId: campaignId, userId, firstAt, lastAt, count }
 */
export const INVITE_VIEWS = "invite_views";
/** Repeat opens within this window are not written again. */
const MIN_GAP_MS = 60 * 1000;

@Injectable()
export class InviteViewsService {
  private indexReady: Promise<unknown> | null = null;

  constructor(
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
  ) {}

  private views() {
    const col = this.inviteModel.db.collection(INVITE_VIEWS);
    this.indexReady ??= col
      .createIndex({ kind: 1, targetId: 1, userId: 1 }, { unique: true })
      .catch(() => (this.indexReady = null));
    return col;
  }

  private async record(kind: "invite" | "campaign", targetId: string, userId: string, now = new Date()) {
    const col = this.views();
    await this.indexReady;
    await col.updateOne(
      { kind, targetId, userId, $or: [{ lastAt: { $lt: new Date(now.getTime() - MIN_GAP_MS) } }, { lastAt: { $exists: false } }] },
      { $setOnInsert: { firstAt: now }, $set: { lastAt: now }, $inc: { count: 1 } },
      { upsert: true },
    ).catch((err: any) => {
      // Duplicate key = a recent view already exists (the filter didn't match it). Fine.
      if (err?.code !== 11000) throw err;
    });
  }

  /** The invite's recipient opened it. Others are ignored (not an error — the modal is shared). */
  async recordInviteView(inviteId: string, userId: string) {
    if (!Types.ObjectId.isValid(inviteId)) throw new BadRequestException("Invalid invite");
    const invite: any = await this.inviteModel.findById(inviteId).select("influencerId").lean();
    if (!invite) throw new NotFoundException("Invite not found");
    if (String(invite.influencerId) !== String(userId)) return { success: true, recorded: false };
    await this.record("invite", inviteId, String(userId));
    return { success: true, recorded: true };
  }

  /** The campaign's owner opened it (where they see responses, counters and payments). */
  async recordCampaignView(campaignId: string, userId: string) {
    if (!Types.ObjectId.isValid(campaignId)) throw new BadRequestException("Invalid campaign");
    const campaign: any = await this.campaignModel.findById(campaignId).select("brandId").lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (String(campaign.brandId) !== String(userId)) throw new ForbiddenException("Not your campaign");
    await this.record("campaign", campaignId, String(userId));
    return { success: true, recorded: true };
  }

  private async findPerson(id: string): Promise<any> {
    if (!Types.ObjectId.isValid(id)) return null;
    const select = "name brandName contactPersonName phoneNumber lastLoginAt lastOpenedAt";
    for (const model of [this.influencerModel, this.photographerModel, this.brandModel]) {
      const p = await model.findById(id).select(select).lean();
      if (p) return p;
    }
    return null;
  }

  /** Admin: follow-up state for every invite of a campaign, keyed by invite id. */
  async adminCampaignFollowUps(campaignId: string) {
    if (!Types.ObjectId.isValid(campaignId)) throw new BadRequestException("Invalid campaign");
    const campaign: any = await this.campaignModel.findById(campaignId).select("brandId campaignType").lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    const invites: any[] = await this.inviteModel
      .find({ campaignId: String(campaignId) })
      .select("_id status counterOffer createdAt updatedAt acceptedAt influencerId")
      .lean();

    const col = this.views();
    const inviteIds = invites.map((i) => String(i._id));
    const [creatorViews, hostView, host] = await Promise.all([
      col.find({ kind: "invite", targetId: { $in: inviteIds } }).toArray(),
      col.findOne({ kind: "campaign", targetId: String(campaignId), userId: String(campaign.brandId) }),
      this.findPerson(String(campaign.brandId)),
    ]);
    const viewByInvite = new Map(creatorViews.map((v: any) => [String(v.targetId), v]));

    const creatorIds = [...new Set(invites.map((i) => String(i.influencerId)))];
    const creators = new Map<string, any>();
    await Promise.all(creatorIds.map(async (id) => creators.set(id, await this.findPerson(id))));

    const byInvite: Record<string, InviteFollowUp & { creatorPhone: string; hostPhone: string; creatorName: string; hostName: string }> = {};
    for (const inv of invites) {
      const creator = creators.get(String(inv.influencerId));
      byInvite[String(inv._id)] = {
        ...buildFollowUp({
          invite: inv,
          campaignType: campaign.campaignType,
          creatorView: viewByInvite.get(String(inv._id)) as any,
          hostView: hostView as any,
          creator,
          host,
        }),
        creatorPhone: String(creator?.phoneNumber || ""),
        hostPhone: String(host?.phoneNumber || ""),
        creatorName: String(creator?.name || ""),
        hostName: String(host?.brandName || host?.contactPersonName || host?.name || ""),
      };
    }
    return { success: true, followUps: byInvite };
  }
}
