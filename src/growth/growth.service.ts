import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection, Types } from "mongoose";
import { escapeHtml } from "../email/layout";
import { sendAppEmail } from "../utils/app-email.service";
import { SingleInstance } from "../utils/single-instance";
import { applyDiscoverableProfileFilter } from "../utils/profile-eligibility.util";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import { rankShortlist } from "./shortlist-match";
import { buildScorecard, scorecardEmailText, unansweredInviteIds } from "./growth-scorecard";
import {
  MIN_COUNT_SHOWN,
  newSignupCode,
  parseShortlistInput,
  parseSignupRef,
  SIGNUP_LINK_DAYS,
  SHORTLIST_BUDGETS,
  SHORTLIST_KEEP_DAYS,
  SHORTLIST_REQUESTS,
  SHORTLIST_STATUSES,
  ShortlistStatus,
} from "./shortlist-request.util";

const DAY = 24 * 60 * 60 * 1000;
const frontendUrl = () => (process.env.FRONTEND_URL || "https://trendstarz.in").replace(/\/$/, "");
const adminTo = () => process.env.ADMIN_EMAIL || "support@trendstarz.in";

@Injectable()
export class GrowthService {
  private readonly logger = new Logger(GrowthService.name);
  private indexReady: Promise<unknown> | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly verification?: SocialAccountVerificationService,
  ) {}

  private db() {
    return this.connection.db as any;
  }

  private requests() {
    const col = this.connection.collection(SHORTLIST_REQUESTS);
    this.indexReady ??= Promise.all([
      col.createIndex({ status: 1, createdAt: -1 }),
      col.createIndex({ phone: 1, createdAt: -1 }),
      col.createIndex({ createdAt: 1 }, { expireAfterSeconds: SHORTLIST_KEEP_DAYS * 24 * 3600 }),
    ]).catch(() => (this.indexReady = null));
    return col;
  }

  // ── Public: "Get a creator shortlist" ──

  /** Approved, discoverable creators for a state + niche; null when too few to show. */
  async creatorCount(state: unknown, category: unknown): Promise<{ count: number | null }> {
    const filter: Record<string, any> = {};
    const s = String(state ?? "").trim().slice(0, 60);
    const c = String(category ?? "").trim().slice(0, 60);
    if (s) filter["location.state"] = s;
    if (c) filter.categories = c;
    applyDiscoverableProfileFilter(filter, { viewerIsAuthenticated: true });
    const count = await this.connection.collection("influencers").countDocuments(filter);
    return { count: count >= MIN_COUNT_SHOWN ? count : null };
  }

  async createRequest(body: any) {
    // Bots fill every field; people never see this one.
    if (String(body?.website ?? "").trim()) return { ok: true };
    const { value, error } = parseShortlistInput(body);
    if (!value) throw new BadRequestException(error);
    const col = this.requests();
    const now = new Date();
    // The same number again within a day: update that request instead of adding one.
    const recent: any = await col.findOne({ phone: value.phone, createdAt: { $gte: new Date(now.getTime() - DAY) } });
    if (recent) {
      await col.updateOne({ _id: recent._id }, { $set: { ...value, updatedAt: now } });
      return { ok: true };
    }
    await col.insertOne({ ...value, status: "new", adminNote: "", createdAt: now, updatedAt: now });
    this.emailAdmin(value).catch(() => undefined);
    return { ok: true };
  }

  private async emailAdmin(v: ReturnType<typeof parseShortlistInput>["value"] & {}) {
    const url = `${frontendUrl()}/admin/growth`;
    const text = [
      `${v.businessName} (${v.name}) asked for a creator shortlist.`,
      "",
      `WhatsApp: +91 ${v.phone}`,
      `Where: ${[v.city, v.state].filter(Boolean).join(", ")}`,
      `Niche: ${v.category}`,
      `Budget: ${SHORTLIST_BUDGETS[v.budget]}`,
      v.note ? `Note: ${v.note}` : "",
      v.attribution.source ? `Came from: ${v.attribution.source}${v.attribution.campaign ? ` (${v.attribution.campaign})` : ""}` : "",
      "",
      `We promised 5 creators within 24 hours. Open: ${url}`,
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n");
    await sendAppEmail({
      to: adminTo(),
      subject: `New shortlist request: ${v.businessName}`.slice(0, 150),
      text,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    }).catch((err: unknown) => this.logger.error(`Shortlist request email failed: ${String(err)}`));
  }

  // ── Admin ──

  async listRequests(status?: string) {
    const filter = status && (SHORTLIST_STATUSES as readonly string[]).includes(status) ? { status } : {};
    return this.requests().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  }

  async updateRequest(id: string, body: any, adminId: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid id");
    const $set: Record<string, any> = { updatedAt: new Date(), updatedBy: String(adminId || "") };
    if (body?.status !== undefined) {
      if (!(SHORTLIST_STATUSES as readonly string[]).includes(body.status)) {
        throw new BadRequestException("Status must be new, contacted, converted or closed");
      }
      $set.status = body.status as ShortlistStatus;
      if (body.status === "contacted") $set.contactedAt = new Date();
    }
    if (body?.adminNote !== undefined) $set.adminNote = String(body.adminNote ?? "").trim().slice(0, 500);
    const res = await this.requests().findOneAndUpdate(
      { _id: new Types.ObjectId(id) },
      { $set },
      { returnDocument: "after" },
    );
    const doc = (res as any)?.value !== undefined ? (res as any).value : res;
    if (!doc) throw new NotFoundException("Request not found");
    return doc;
  }

  private async findRequest(id: string): Promise<any> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid id");
    const doc = await this.requests().findOne({ _id: new Types.ObjectId(id) });
    if (!doc) throw new NotFoundException("Request not found");
    return doc;
  }

  /**
   * Admin "Build shortlist": creators in the request's state with the niche,
   * whose profile a guest can open, best first (shortlist-match.ts). When the
   * niche has fewer than 5 there, creators in the state from other niches follow.
   */
  async matchesFor(id: string, limit = 15) {
    const request = await this.findRequest(id);
    const projection = {
      name: 1, username: 1, publicId: 1, location: 1, categories: 1, influencerCategory: 1,
      socialMedia: 1, lastLoginAt: 1, lastOpenedAt: 1,
    };
    const base = () => applyDiscoverableProfileFilter({ "location.state": request.state }, { viewerIsAuthenticated: false });
    const col = this.connection.collection("influencers");
    const inNiche = await col.find({ ...base(), categories: request.category }, { projection }).limit(500).toArray();
    let others: any[] = [];
    if (inNiche.length < 5) {
      const f = base();
      f.$and.push({ categories: { $ne: request.category } });
      others = await col.find(f, { projection }).limit(200).toArray();
    }
    const all = [...inNiche, ...others];
    const statuses = this.verification
      ? await this.verification.statusesForProfiles("Influencer", all as any).catch(() => new Map())
      : new Map();
    const verifiedById = new Map<string, Set<string>>();
    for (const [profileId, perAccount] of statuses as Map<string, Map<string, { tier?: string }>>) {
      verifiedById.set(profileId, new Set([...perAccount].filter(([, v]) => v.tier === "verified").map(([k]) => k)));
    }
    const now = new Date();
    const ranked = [
      ...rankShortlist(request, inNiche, verifiedById, now),
      ...rankShortlist(request, others, verifiedById, now),
    ];
    return {
      request: { _id: String(request._id), category: request.category, state: request.state, city: request.city, budget: request.budget },
      inNiche: inNiche.length,
      candidates: ranked.slice(0, limit).map((c) => ({ ...c, inNiche: inNiche.some((d) => String(d._id) === c.id) })),
    };
  }

  /** Admin: the brand signup link for this request (same link if asked again). */
  async signupLink(id: string) {
    const request = await this.findRequest(id);
    let code = String(request.signupCode || "");
    if (!code) {
      code = newSignupCode();
      await this.requests().updateOne({ _id: request._id, signupCode: null }, { $set: { signupCode: code } });
      const fresh: any = await this.requests().findOne({ _id: request._id }, { projection: { signupCode: 1 } });
      code = String(fresh?.signupCode || code);
    }
    const params = new URLSearchParams({
      shortlist: `${request._id}.${code}`,
      utm_source: "whatsapp",
      utm_medium: "shortlist",
      utm_campaign: "shortlist-request",
    });
    return { link: `${frontendUrl()}/register-brand?${params}` };
  }

  /** Public: the brand's own details for the signup form, only with the right code. */
  async prefill(ref: unknown) {
    const parts = parseSignupRef(ref);
    if (!parts) throw new NotFoundException("This link isn't valid.");
    const doc: any = await this.requests().findOne({ _id: new Types.ObjectId(parts.id), signupCode: parts.code });
    if (!doc || doc.brandId || Date.now() - new Date(doc.createdAt).getTime() > SIGNUP_LINK_DAYS * DAY) {
      throw new NotFoundException("This link has expired or was already used.");
    }
    return {
      name: doc.name,
      businessName: doc.businessName,
      phone: doc.phone,
      state: doc.state,
      city: doc.city,
      category: doc.category,
    };
  }

  scorecard() {
    return buildScorecard(this.db(), new Date());
  }

  /** Invites waiting 24h+ for a creator's answer on live campaigns, oldest first, with who to message. */
  async unansweredInvites() {
    const now = new Date();
    const rows: any[] = await unansweredInviteIds(this.db(), now);
    if (!rows.length) return [];
    const db = this.db();
    const objIds = (list: string[]) => list.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const campaigns = await db
      .collection("campaigns")
      .find({ _id: { $in: objIds(rows.map((r) => String(r.campaignId))) } }, { projection: { title: 1, campaignNumber: 1 } })
      .toArray();
    const creatorIds = objIds(rows.map((r) => String(r.influencerId)));
    const creators = [
      ...(await db.collection("influencers").find({ _id: { $in: creatorIds } }, { projection: { name: 1, username: 1, publicId: 1, phoneNumber: 1, lastLoginAt: 1, lastOpenedAt: 1 } }).toArray()),
      ...(await db.collection("photographers").find({ _id: { $in: creatorIds } }, { projection: { name: 1, username: 1, publicId: 1, phoneNumber: 1, lastLoginAt: 1, lastOpenedAt: 1 } }).toArray()),
    ];
    const hosts = await db
      .collection("brands")
      .find({ _id: { $in: objIds(rows.map((r) => String(r.brandId))) } }, { projection: { brandName: 1 } })
      .toArray();
    const views = await db
      .collection("invite_views")
      .find({ kind: "invite", targetId: { $in: rows.map((r) => String(r._id)) } }, { projection: { targetId: 1, lastAt: 1 } })
      .toArray();
    const by = (list: any[]) => new Map(list.map((d) => [String(d._id), d]));
    const c = by(campaigns);
    const cr = by(creators);
    const h = by(hosts);
    const seen = new Map(views.map((v: any) => [String(v.targetId), v.lastAt]));
    return rows
      .map((r) => {
        const creator: any = cr.get(String(r.influencerId)) || {};
        const campaign: any = c.get(String(r.campaignId)) || {};
        const role = String(r.recipientRole || "").toLowerCase() === "photographer" ? "photographer" : "influencer";
        const active = Math.max(
          creator.lastLoginAt ? new Date(creator.lastLoginAt).getTime() : 0,
          creator.lastOpenedAt ? new Date(creator.lastOpenedAt).getTime() : 0,
        );
        return {
          inviteId: String(r._id),
          campaignId: String(r.campaignId),
          campaignTitle: campaign.title || "",
          campaignNumber: campaign.campaignNumber ?? null,
          hostName: (h.get(String(r.brandId)) as any)?.brandName || "",
          creatorId: String(r.influencerId),
          creatorRole: role,
          creatorName: creator.name || creator.username || "",
          creatorPublicId: creator.publicId || "",
          creatorPhone: creator.phoneNumber || "",
          invitedAt: r.createdAt,
          hoursWaiting: Math.floor((now.getTime() - new Date(r.createdAt).getTime()) / 3600000),
          openedAt: seen.get(String(r._id)) || null,
          lastActiveAt: active ? new Date(active) : null,
          creatorReminded: !!r.unansweredCreatorReminderAt,
          hostTold: !!r.unansweredHostNudgeAt,
          inviteLink: `${frontendUrl()}/${role}-dashboard?invite=${r._id}`,
        };
      })
      .sort((a, b) => b.hoursWaiting - a.hoursWaiting);
  }

  /** Dashboard counts. */
  async summary() {
    const s = await this.requests().countDocuments({ status: "new" });
    const unanswered = (await unansweredInviteIds(this.db(), new Date())).length;
    return { newShortlistRequests: s, unansweredInvites: unanswered };
  }

  // ── Monday email ──

  @Cron("0 9 * * 1", { timeZone: "Asia/Kolkata", name: "growthScorecardEmail" })
  @SingleInstance()
  async weeklyEmail() {
    try {
      const card = await this.scorecard();
      const text = scorecardEmailText(card, `${frontendUrl()}/admin/growth`);
      await sendAppEmail({
        to: adminTo(),
        subject: `TrendStarZ this week: ${card.outsideBrands.total} outside brands, ${card.invitesSent.last7} invites`,
        text,
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
      });
    } catch (err: any) {
      this.logger.error(`Weekly growth email failed: ${err?.message || err}`);
    }
  }
}
