import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { CollaborationRecord, summarizeInvites } from "./collaboration-record.util";

type Role = "influencer" | "brand" | "photographer";
const ROLES: Role[] = ["influencer", "brand", "photographer"];
const FIELDS = "_id status campaignId withdrawnReasonCode withdrawnReason missExcused";

@Injectable()
export class CollaborationRecordService {
  constructor(
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("CampaignSubmission") private readonly submissionModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
  ) {}

  private async lateIds(invites: any[]): Promise<Set<string>> {
    const finished = invites.filter((i) => ["completed", "approved"].includes(String(i.status))).map((i) => i._id);
    if (!finished.length) return new Set();
    const late = await this.submissionModel.distinct("inviteId", { inviteId: { $in: finished }, isLate: true });
    return new Set(late.map(String));
  }

  /** Creators (influencer/photographer) get both sides; brands only host. Read-only. */
  async forUser(userId: string, role: string): Promise<CollaborationRecord> {
    const r = String(role || "").toLowerCase() as Role;
    if (!ROLES.includes(r)) throw new BadRequestException("Unknown account type");
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException("Invalid user");

    const [received, sent] = await Promise.all([
      r === "brand"
        ? Promise.resolve([])
        : this.inviteModel.find({ influencerId: new Types.ObjectId(userId) }).select(FIELDS).lean(),
      this.inviteModel.find({ brandId: String(userId) }).select(FIELDS).lean(),
    ]);
    const [lateReceived, lateSent] = await Promise.all([this.lateIds(received), this.lateIds(sent)]);

    return {
      asCreator: r === "brand" ? null : summarizeInvites(received, lateReceived),
      asHost:
        r === "brand" || sent.length
          ? { ...summarizeInvites(sent, lateSent), campaigns: new Set(sent.map((i: any) => String(i.campaignId))).size }
          : null,
    };
  }

  /**
   * Every creator's (side "creator") or host's (side "host") record, for the
   * admin Collaboration records page. Reads all invites once (fine at today's
   * size; move to an aggregation when invites reach the tens of thousands).
   */
  async listAll(sideInput: string) {
    const side = sideInput === "host" ? "host" : "creator";
    const invites: any[] = await this.inviteModel
      .find({})
      .select(`${FIELDS} influencerId brandId`)
      .lean();
    const late = await this.lateIds(invites);
    const key = (i: any) => String(side === "host" ? i.brandId : i.influencerId);

    const byUser = new Map<string, any[]>();
    for (const i of invites) {
      const k = key(i);
      if (!Types.ObjectId.isValid(k)) continue;
      if (!byUser.has(k)) byUser.set(k, []);
      byUser.get(k)!.push(i);
    }

    // Names from whichever profile the id belongs to (a host can be any role).
    const ids = [...byUser.keys()].map((k) => new Types.ObjectId(k));
    const select = "name brandName username brandUsername email isDeleted status";
    const [infs, brands, photos] = await Promise.all([
      this.influencerModel.find({ _id: { $in: ids } }).select(select).lean(),
      side === "host" ? this.brandModel.find({ _id: { $in: ids } }).select(select).lean() : Promise.resolve([]),
      this.photographerModel.find({ _id: { $in: ids } }).select(select).lean(),
    ]);
    const who = new Map<string, { role: Role; p: any }>();
    for (const p of infs as any[]) who.set(String(p._id), { role: "influencer", p });
    for (const p of brands as any[]) who.set(String(p._id), { role: "brand", p });
    for (const p of photos as any[]) who.set(String(p._id), { role: "photographer", p });

    const rows = [...byUser.entries()].map(([userId, list]) => {
      const found = who.get(userId);
      const p = found?.p || {};
      const summary = summarizeInvites(list, late);
      return {
        userId,
        role: found?.role || null,
        name: p.name || p.brandName || "(account removed)",
        username: p.username || p.brandUsername || "",
        removed: !found || p.isDeleted === true || p.status === "deleted",
        ...summary,
        ...(side === "host" ? { campaigns: new Set(list.map((i) => String(i.campaignId))).size } : {}),
      };
    });
    rows.sort((a, b) => b.didNotPost - a.didNotPost || b.total - a.total);
    return { success: true, side, rows };
  }
}
