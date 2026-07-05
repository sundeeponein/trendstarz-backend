import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as crypto from "crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid ambiguity
const CODE_LENGTH = 8;

// Statuses where the collaboration is live enough for a promo link to be worth generating.
const TRACKABLE_INVITE_STATUSES = [
  "accepted",
  "payment_confirmed",
  "working",
  "submitted",
  "completed",
  "approved",
];

function generateCode(): string {
  let out = "";
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(String(ip || "")).digest("hex");
}

function deviceTypeFromUserAgent(ua: string): "mobile" | "tablet" | "desktop" | "other" {
  const s = String(ua || "").toLowerCase();
  if (!s) return "other";
  if (/ipad|tablet/.test(s)) return "tablet";
  if (/mobi|android|iphone/.test(s)) return "mobile";
  if (/mozilla|chrome|safari|firefox|edg/.test(s)) return "desktop";
  return "other";
}

@Injectable()
export class TrackingLinksService {
  constructor(
    @InjectModel("TrackingLink") private readonly trackingLinkModel: Model<any>,
    @InjectModel("LinkClick") private readonly linkClickModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly campaignInviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
  ) {}

  private buildTrackingUrl(code: string): string {
    return `https://www.trendstarz.in/r/${code}`;
  }

  private toPublicShape(doc: any) {
    return {
      code: doc.code,
      url: this.buildTrackingUrl(doc.code),
      clickCount: doc.clickCount || 0,
      platform: doc.platform || "",
      contentType: doc.contentType || "",
      destinationUrl: doc.destinationUrl || "",
      destinationType: doc.destinationType || "other",
      moduleType: doc.moduleType || "campaign",
    };
  }

  /** Get-or-create the tracking link for an accepted invite. Callable by the recipient, the campaign host, or admin. */
  async getOrCreateForInvite(inviteId: string, requesterId: string, isAdmin = false) {
    const invite: any = await this.campaignInviteModel.findById(inviteId).lean();
    if (!invite) throw new NotFoundException("Invite not found");

    if (!TRACKABLE_INVITE_STATUSES.includes(String(invite.status || ""))) {
      throw new BadRequestException("This invite is not accepted yet");
    }

    const campaign: any = await this.campaignModel.findById(invite.campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");

    const requester = String(requesterId || "");
    const recipientId = String(invite.influencerId || "");
    const hostId = String(campaign.brandId || "");
    if (!isAdmin && requester !== recipientId && requester !== hostId) {
      throw new ForbiddenException("Not authorized for this invite's tracking link");
    }

    const destinationUrl = String(campaign.promotionUrl || "").trim();
    if (!destinationUrl) {
      throw new BadRequestException("This campaign has no promotion link configured");
    }

    const existing: any = await this.trackingLinkModel.findOne({ inviteId: String(invite._id) }).lean();
    if (existing) return this.toPublicShape(existing);

    const hostType = campaign.ownerType === "photographer" ? "photographer" : "brand";
    const recipientType =
      (invite as any).recipientRole === "photographer" || campaign.inviteRecipientRole === "photographer"
        ? "photographer"
        : "influencer";

    let code = generateCode();
    // Extremely unlikely to collide, but guard against it anyway.
    for (let attempt = 0; attempt < 5; attempt++) {
      const collision = await this.trackingLinkModel.exists({ code });
      if (!collision) break;
      code = generateCode();
    }

    const created = await this.trackingLinkModel.create({
      code,
      campaignId: String(campaign._id),
      inviteId: String(invite._id),
      hostId,
      hostType,
      recipientId,
      recipientType,
      platform: String(invite.selectedPlatform || ""),
      contentType: String(invite.selectedContentType || ""),
      destinationUrl,
      destinationType: String(campaign.promotionUrlType || "other"),
      moduleType: "campaign",
    });

    return this.toPublicShape(created);
  }

  /** Public — resolves a short code to its destination and logs the click. Never throws; returns null on miss. */
  async resolveAndRecordClick(
    code: string,
    meta: { ip?: string; userAgent?: string; referrer?: string },
  ): Promise<{ destinationUrl: string } | null> {
    const trackingLink = await this.trackingLinkModel.findOne({ code: String(code || "").toUpperCase() });
    if (!trackingLink) return null;

    await this.linkClickModel.create({
      trackingLinkId: trackingLink._id,
      ipHash: hashIp(meta.ip || ""),
      userAgent: String(meta.userAgent || "").slice(0, 300),
      referrer: String(meta.referrer || "").slice(0, 300),
      deviceType: deviceTypeFromUserAgent(meta.userAgent || ""),
    });
    await this.trackingLinkModel.updateOne({ _id: trackingLink._id }, { $inc: { clickCount: 1 } });

    return { destinationUrl: trackingLink.destinationUrl };
  }

  /** Admin-only aggregate view across all tracking links. */
  async getAdminAnalytics(filters: { campaignId?: string; hostId?: string; limit?: number } = {}) {
    const query: any = {};
    if (filters.campaignId) query.campaignId = filters.campaignId;
    if (filters.hostId) query.hostId = filters.hostId;

    const links = await this.trackingLinkModel.find(query).sort({ createdAt: -1 }).lean();
    const linkIds = links.map((l) => l._id);

    const campaignIds = [...new Set(links.map((l) => String(l.campaignId)).filter(Boolean))];
    const campaignRows = campaignIds.length
      ? await this.campaignModel
          .find({ _id: { $in: campaignIds } })
          .select("campaignNumber title")
          .lean()
      : [];
    const campaignNumberById = new Map(
      campaignRows.map((c: any) => [String(c._id), c.campaignNumber]),
    );
    const campaignTitleById = new Map(
      campaignRows.map((c: any) => [String(c._id), c.title]),
    );

    const brandHostIds = [
      ...new Set(
        links.filter((l) => l.hostType !== "photographer").map((l) => String(l.hostId)).filter(Boolean),
      ),
    ];
    const photographerHostIds = [
      ...new Set(
        links.filter((l) => l.hostType === "photographer").map((l) => String(l.hostId)).filter(Boolean),
      ),
    ];
    const [brandHostRows, photographerHostRows] = await Promise.all([
      brandHostIds.length
        ? this.brandModel.find({ _id: { $in: brandHostIds } }).select("brandName").lean()
        : [],
      photographerHostIds.length
        ? this.photographerModel.find({ _id: { $in: photographerHostIds } }).select("name").lean()
        : [],
    ]);
    const hostNameById = new Map<string, string>([
      ...brandHostRows.map((b: any): [string, string] => [String(b._id), b.brandName]),
      ...photographerHostRows.map((p: any): [string, string] => [String(p._id), p.name]),
    ]);

    const uniqueByLink = await this.linkClickModel.aggregate([
      { $match: { trackingLinkId: { $in: linkIds } } },
      { $group: { _id: { link: "$trackingLinkId", ip: "$ipHash" } } },
      { $group: { _id: "$_id.link", uniqueClicks: { $sum: 1 } } },
    ]);
    const uniqueMap = new Map(uniqueByLink.map((u: any) => [String(u._id), u.uniqueClicks]));

    const totalClicks = links.reduce((sum, l) => sum + (l.clickCount || 0), 0);
    const totalUniqueClicks = uniqueByLink.reduce((sum: number, u: any) => sum + u.uniqueClicks, 0);

    const perCampaign = new Map<
      string,
      { campaignId: string; campaignNumber?: number; campaignTitle?: string; links: number; clicks: number }
    >();
    for (const l of links) {
      const key = String(l.campaignId);
      const row = perCampaign.get(key) || {
        campaignId: key,
        campaignNumber: campaignNumberById.get(key),
        campaignTitle: campaignTitleById.get(key),
        links: 0,
        clicks: 0,
      };
      row.links += 1;
      row.clicks += l.clickCount || 0;
      perCampaign.set(key, row);
    }

    const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
    const topPerformers = [...links]
      .sort((a, b) => (b.clickCount || 0) - (a.clickCount || 0))
      .slice(0, limit)
      .map((l) => ({
        code: l.code,
        campaignId: String(l.campaignId),
        campaignNumber: campaignNumberById.get(String(l.campaignId)),
        hostId: String(l.hostId),
        hostType: l.hostType,
        hostName: hostNameById.get(String(l.hostId)) || "",
        recipientId: String(l.recipientId),
        recipientType: l.recipientType,
        platform: l.platform,
        contentType: l.contentType,
        clickCount: l.clickCount || 0,
        uniqueClicks: uniqueMap.get(String(l._id)) || 0,
        createdAt: l.createdAt,
      }));

    const zeroActivity = links
      .filter((l) => !l.clickCount)
      .slice(0, limit)
      .map((l) => ({
        code: l.code,
        campaignId: String(l.campaignId),
        campaignNumber: campaignNumberById.get(String(l.campaignId)),
        recipientId: String(l.recipientId),
        platform: l.platform,
        contentType: l.contentType,
        createdAt: l.createdAt,
      }));

    return {
      overview: {
        totalLinks: links.length,
        totalClicks,
        totalUniqueClicks,
      },
      perCampaign: [...perCampaign.values()].sort((a, b) => b.clicks - a.clicks),
      topPerformers,
      zeroActivity,
    };
  }
}
