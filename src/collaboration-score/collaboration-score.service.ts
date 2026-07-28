import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { RazorpayService } from "../payment/razorpay.service";
import { MetaOAuthService } from "../meta-oauth/meta-oauth.service";
import { ProfileVerificationService } from "../profile-verification/profile-verification.service";
import { CollaborationScoreRulesService } from "./collaboration-score-rules.service";
import { CollaborationScoreAiService } from "./collaboration-score-ai.service";
import { CollaborationScoreSettingsService } from "./collaboration-score-settings.service";
import { YoutubeCollectorService } from "./collectors/youtube-collector.service";
import { InstagramCollectorService } from "./collectors/instagram-collector.service";
import { FacebookCollectorService } from "./collectors/facebook-collector.service";
import { LinkedinCollectorService } from "./collectors/linkedin-collector.service";
import {
  CollaborationScorePlatform,
  CollectedPlatformData,
  ProfileCollector,
} from "./collectors/collector.interface";

type CollaborationScoreUserType = "Influencer" | "Brand" | "Photographer";
type AuditTrigger = "USER" | "ADMIN" | "SYSTEM_NIGHTLY";

export interface SocialConnectionDetail {
  handle: string | null;
  followersCount: number | null;
  connectedAt: Date;
}

// Fields a brand-role caller is allowed to see, per spec: "Never show AI
// prompts. Never show internal calculations." Enforced server-side here,
// not just hidden in the UI.
const BRAND_SAFE_FIELDS = [
  "userId",
  "userType",
  "collaborationScore",
  "campaignReadiness",
  "trendstarzRecommended",
  "pricingSuggestion",
  "categoryMatch",
  "portfolioScore",
  "createdAt",
] as const;

function toObjectId(value: string) {
  return new Types.ObjectId(value);
}

@Injectable()
export class CollaborationScoreService {
  private readonly collectors: Record<CollaborationScorePlatform, ProfileCollector>;

  constructor(
    @InjectModel("CollaborationAudit") private readonly auditModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Payment") private readonly paymentModel: Model<any>,
    @InjectModel("Transaction") private readonly transactionModel: Model<any>,
    @InjectModel("SocialOAuthConnection") private readonly connectionModel: Model<any>,
    private readonly profileVerificationService: ProfileVerificationService,
    private readonly rulesService: CollaborationScoreRulesService,
    private readonly aiService: CollaborationScoreAiService,
    private readonly settingsService: CollaborationScoreSettingsService,
    private readonly razorpayService: RazorpayService,
    private readonly metaOAuthService: MetaOAuthService,
    youtubeCollector: YoutubeCollectorService,
    instagramCollector: InstagramCollectorService,
    facebookCollector: FacebookCollectorService,
    linkedinCollector: LinkedinCollectorService,
  ) {
    this.collectors = {
      YouTube: youtubeCollector,
      Instagram: instagramCollector,
      Facebook: facebookCollector,
      LinkedIn: linkedinCollector,
    };
  }

  private assertAdmin(actor: any) {
    if (String(actor?.role || "").toLowerCase() !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
  }

  private modelForUserType(userType: CollaborationScoreUserType): Model<any> {
    if (userType === "Brand") return this.brandModel;
    if (userType === "Photographer") return this.photographerModel;
    return this.influencerModel;
  }

  private matchPlatform(platformName: string): CollaborationScorePlatform | null {
    const normalized = String(platformName || "").trim().toLowerCase();
    if (normalized === "youtube") return "YouTube";
    if (normalized === "instagram") return "Instagram";
    if (normalized === "facebook") return "Facebook";
    if (normalized === "linkedin") return "LinkedIn";
    return null;
  }

  private async collectPlatforms(
    profile: any,
    platformsEnabled: Record<string, boolean>,
    userId: string,
  ): Promise<CollectedPlatformData[]> {
    const entries: any[] = Array.isArray(profile?.socialMedia) ? profile.socialMedia : [];
    const results: CollectedPlatformData[] = [];
    for (const entry of entries) {
      const platform = this.matchPlatform(entry?.platform);
      if (!platform) continue;
      if (platformsEnabled[platform.toLowerCase()] === false) continue;
      const collected = await this.collectors[platform].collect(entry, userId);
      if (collected) results.push(collected);
    }
    return results;
  }

  private bioTextFor(profile: any): string {
    return String(
      profile?.description || profile?.expertiseArea || profile?.professionalStatus || "",
    ).trim();
  }

  private categoriesFor(profile: any, userType: CollaborationScoreUserType): string[] {
    if (userType === "Photographer") return profile?.skills || [];
    const categories: string[] = Array.isArray(profile?.categories) ? profile.categories : [];
    const primary = profile?.influencerCategory ? [profile.influencerCategory] : [];
    return Array.from(new Set([...primary, ...categories]));
  }

  /**
   * Anonymous, pre-registration teaser — no userId, nothing persisted. Only
   * YouTube is supported: Instagram/Facebook/LinkedIn collectors read
   * self-reported data off an existing profile, so there's no honest score
   * to give a visitor who hasn't registered yet.
   */
  async previewFromYoutubeUrl(youtubeUrl: string): Promise<{
    platform: "YouTube";
    handle: string;
    previewScore: number;
    confidence: number;
    confidenceReason: string;
  }> {
    const handle = String(youtubeUrl || "").trim();
    if (!handle) throw new BadRequestException("A YouTube channel URL is required");

    const settings = await this.settingsService.getSettings();
    if (!settings.anonymousPreviewEnabled) {
      throw new BadRequestException("The free score preview is currently unavailable. Please register to check your score.");
    }

    const collected = await this.collectors.YouTube.collect({ handle });
    if (!collected) {
      throw new BadRequestException(
        "Could not find a public YouTube channel at that URL. Please check the link and try again.",
      );
    }

    const { previewScore } = this.rulesService.computePreviewScores([collected], settings);

    return {
      platform: "YouTube",
      handle: collected.handle,
      previewScore,
      confidence: collected.confidence,
      confidenceReason: collected.confidenceReason,
    };
  }

  /**
   * Hard floor for everyone — even a paid re-analysis only becomes available
   * once this has elapsed; paying never bypasses it early. Admin/nightly
   * triggers bypass this entirely.
   */
  private async assertCooldownElapsed(userId: string, cooldownDays: number): Promise<void> {
    if (cooldownDays <= 0) return;
    const previous: any = await this.auditModel
      .findOne({ userId: String(userId), isCurrent: true })
      .select("createdAt")
      .lean();
    if (!previous?.createdAt) return;
    const availableAt = new Date(
      new Date(previous.createdAt).getTime() + cooldownDays * 24 * 60 * 60 * 1000,
    );
    if (Date.now() < availableAt.getTime()) {
      throw new BadRequestException(
        `You can re-analyze again on ${availableAt.toDateString()} (${cooldownDays}-day limit between analyses).`,
      );
    }
  }

  /**
   * The first `freeAuditCount` audits (default 1) are free; every one after
   * that requires a captured payment (see createReanalysisOrder/
   * verifyReanalysisPayment) — applies uniformly to existing and new
   * accounts alike, no grandfathering.
   */
  private async assertFreeAuditAvailable(userId: string, freeAuditCount: number): Promise<void> {
    if (freeAuditCount <= 0) return;
    const priorAuditCount = await this.auditModel.countDocuments({ userId: String(userId) });
    if (priorAuditCount >= freeAuditCount) {
      throw new HttpException(
        {
          code: "PAYMENT_REQUIRED",
          message: "Your free audit has already been used. Pay to re-analyze.",
        },
        402,
      );
    }
  }

  /**
   * Runs one audit end-to-end and persists it. Read-only against the
   * Influencer/Brand/Photographer collections — never writes
   * profileQualityScore/profileQualityLabel/profileTier/verifiedByTrendStarz/
   * verificationStatus. Those stay owned exclusively by
   * ProfileVerificationService.
   */
  async runAudit(
    userId: string,
    role: any,
    trigger: AuditTrigger = "USER",
    opts: { skipFreeGate?: boolean; isPaid?: boolean } = {},
  ) {
    const startedAt = Date.now();
    const settings = await this.settingsService.getSettings();

    if (trigger === "USER") {
      await this.assertCooldownElapsed(userId, settings.reanalysisCooldownDays);
      if (!opts.skipFreeGate) {
        await this.assertFreeAuditAvailable(userId, settings.freeAuditCount);
      }
    }

    const snapshot = await this.profileVerificationService.getCompletionSnapshot(
      userId,
      role,
    );
    if (snapshot.userType === "User") {
      throw new NotFoundException("Collaboration Score is not available for this account type");
    }
    const userType = snapshot.userType as CollaborationScoreUserType;
    const { completion, flags } = snapshot;
    const profile = await this.modelForUserType(userType).findById(userId).lean();
    if (!profile) throw new NotFoundException("Profile not found");

    const eligibility = this.profileVerificationService.buildEligibility(
      profile,
      flags,
      userType,
    );
    const collectedPlatforms = await this.collectPlatforms(
      profile,
      settings.platformsEnabled as unknown as Record<string, boolean>,
      String(userId),
    );

    let aiResult = null;
    let aiUsed = false;
    let aiInputTokens = 0;
    let aiOutputTokens = 0;
    let aiCostUsd = 0;

    if (settings.aiEnabled) {
      try {
        const aiCall = await this.aiService.analyzeContentSync({
          userId: String(userId),
          bioText: this.bioTextFor(profile),
          categories: this.categoriesFor(profile, userType),
          platforms: collectedPlatforms,
        });
        aiResult = aiCall.result;
        aiUsed = true;
        aiInputTokens = aiCall.inputTokens;
        aiOutputTokens = aiCall.outputTokens;
        aiCostUsd = aiCall.costUsd;
      } catch {
        // AI failure never blocks the rules-only score from being produced.
        aiResult = null;
        aiUsed = false;
      }
    }

    const scores = this.rulesService.computeScores({
      profile,
      userType,
      completion,
      flags,
      eligibility,
      collectedPlatforms,
      settings,
      aiResult,
    });

    const previousCurrent: any = await this.auditModel
      .findOne({ userId: String(userId), isCurrent: true })
      .lean();
    const nextVersion = (previousCurrent?.version || 0) + 1;
    if (previousCurrent) {
      await this.auditModel.updateOne(
        { _id: previousCurrent._id },
        { $set: { isCurrent: false } },
      );
    }

    let created: any;
    try {
      created = await this.auditModel.create({
        userId: String(userId),
        userType,
        version: nextVersion,
        isCurrent: true,
        platformsCollected: collectedPlatforms.map((p) => ({
          platform: p.platform,
          method: p.method,
          handle: p.handle,
          collectedAt: p.collectedAt,
          raw: p.raw,
          confidence: p.confidence,
          confidenceReason: p.confidenceReason,
        })),
        profileCompletenessScore: scores.profileCompletenessScore,
        contentQualityScore: scores.contentQualityScore,
        postingConsistencyScore: scores.postingConsistencyScore,
        professionalBrandingScore: scores.professionalBrandingScore,
        campaignReadinessScore: scores.campaignReadinessScore,
        collaborationScore: scores.collaborationScore,
        portfolioScore: scores.portfolioScore,
        campaignReadiness: scores.campaignReadiness,
        trendstarzRecommended: scores.trendstarzRecommended,
        trendstarzRecommendedMinScore: scores.trendstarzRecommendedMinScore,
        pricingSuggestion: scores.pricingSuggestion,
        categoryMatch: scores.categoryMatch,
        aiAnalysis: aiResult,
        aiUsed,
        aiModel: aiUsed ? settings.aiModel : null,
        aiCallType: aiUsed ? "sync" : null,
        aiInputTokens,
        aiOutputTokens,
        aiCostUsd,
        strengths: scores.strengths,
        improvements: scores.improvements,
        recommendations: scores.recommendations,
        status: "completed",
        triggeredBy: trigger,
        isPaid: !!opts.isPaid,
        durationMs: Date.now() - startedAt,
      });
    } catch (err: any) {
      // Unique index on {userId, version} — a concurrent request (double
      // click, refresh-and-retry, two open tabs) already created this same
      // next version first. Fail fast with a clear message instead of a
      // raw duplicate-key error.
      if (err?.code === 11000) {
        throw new BadRequestException(
          "An audit is already being generated for this account. Please wait a moment and try again.",
        );
      }
      throw err;
    }

    return created.toObject();
  }

  async getAuditForUser(targetUserId: string, requester: any) {
    const audit: any = await this.auditModel
      .findOne({ userId: String(targetUserId), isCurrent: true })
      .lean();
    if (!audit) throw new NotFoundException("No Collaboration Score audit found for this user");

    const requesterId = String(
      requester?.userId || requester?.sub || requester?.id || "",
    ).trim();
    const isSelf = requesterId && requesterId === String(targetUserId);
    const isAdmin = String(requester?.role || "").toLowerCase() === "admin";
    const isBrand = String(requester?.role || "").toLowerCase() === "brand";

    if (isSelf || isAdmin) {
      const settings = await this.settingsService.getSettings();
      const availableAt = new Date(
        new Date(audit.createdAt).getTime() +
          settings.reanalysisCooldownDays * 24 * 60 * 60 * 1000,
      );
      const canReanalyze = settings.reanalysisCooldownDays <= 0 || Date.now() >= availableAt.getTime();
      return {
        ...audit,
        canReanalyze,
        reanalysisAvailableAt: canReanalyze ? null : availableAt,
        reanalysisFeeRupees: settings.reanalysisFeeRupees,
      };
    }
    if (isBrand) {
      const filtered: any = {};
      for (const field of BRAND_SAFE_FIELDS) filtered[field] = (audit as any)[field];
      return filtered;
    }
    // Any other role gets the same brand-safe projection by default —
    // conservative default, never leak AI prompts/internal calculations.
    const filtered: any = {};
    for (const field of BRAND_SAFE_FIELDS) filtered[field] = (audit as any)[field];
    return filtered;
  }

  private paymentUserType(role: any): CollaborationScoreUserType {
    const normalized = String(role || "").toLowerCase();
    if (normalized === "brand") return "Brand";
    if (normalized === "photographer") return "Photographer";
    return "Influencer";
  }

  /**
   * Rejects early if the cooldown hasn't elapsed yet — no point charging for
   * something that isn't available. Dedupes any stale pending order first
   * (invite_unlock doesn't do this; closing that gap here).
   */
  async createReanalysisOrder(userId: string, role: any) {
    const settings = await this.settingsService.getSettings();
    await this.assertCooldownElapsed(userId, settings.reanalysisCooldownDays);

    await this.paymentModel.deleteMany({
      userId: toObjectId(userId),
      purpose: "collab_score_reanalysis",
      status: "pending",
    });

    const amountPaise = Math.round(settings.reanalysisFeeRupees * 100);
    const order = await this.razorpayService.createOrder(amountPaise, {
      userId: String(userId),
      premiumDuration: "1m",
    });

    const userType = this.paymentUserType(role);
    await this.paymentModel.create({
      userId: toObjectId(userId),
      userType,
      transactionId: `rzp_reanalysis_${Date.now()}`,
      amount: amountPaise,
      premiumDuration: "1m",
      status: "pending",
      paymentMethod: "razorpay",
      gatewayProvider: "razorpay",
      purpose: "collab_score_reanalysis",
      orderId: order.orderId,
      paymentStatus: "created",
    });

    await this.transactionModel.create({
      userId: toObjectId(userId),
      userRole: String(role || "influencer").toLowerCase(),
      type: "collab_score_reanalysis_payment",
      amount: settings.reanalysisFeeRupees,
      paymentProvider: "razorpay",
      orderId: order.orderId,
      paymentStatus: "created",
      logs: [{ event: "order_created" }],
    });

    return { order };
  }

  /**
   * Idempotent on repeat verify (e.g. a page refresh after payment) — only
   * runs the actual audit once per captured payment.
   */
  async verifyReanalysisPayment(
    userId: string,
    role: any,
    input: { orderId: string; paymentId: string; signature: string },
  ) {
    const valid = this.razorpayService.verifySignature(
      input.orderId,
      input.paymentId,
      input.signature,
    );
    if (!valid) {
      throw new BadRequestException("Invalid payment signature");
    }

    const payment: any = await this.paymentModel.findOne({
      orderId: input.orderId,
      userId: toObjectId(userId),
      purpose: "collab_score_reanalysis",
    });
    if (!payment) throw new NotFoundException("Payment order not found");

    if (payment.paymentStatus === "captured" && payment.status === "approved") {
      return this.getAuditForUser(userId, { userId, role });
    }

    payment.paymentId = input.paymentId;
    payment.paymentStatus = "captured";
    payment.status = "approved";
    payment.gatewayVerifiedAt = new Date();
    payment.gatewaySignature = input.signature;
    await payment.save();

    await this.transactionModel.updateMany(
      { orderId: input.orderId },
      {
        $set: { paymentId: input.paymentId, paymentStatus: "captured" },
        $push: { logs: { at: new Date(), event: "payment_captured" } },
      },
    );

    await this.runAudit(userId, role, "USER", { skipFreeGate: true, isPaid: true });
    return this.getAuditForUser(userId, { userId, role });
  }

  /**
   * Every audit run is preserved (version + isCurrent, never overwritten —
   * see collaboration-audit.schema.ts), so history is a read query, not new
   * storage. Self/admin only — brands don't need a creator's score history.
   */
  async getAuditHistory(targetUserId: string, requester: any, limit = 10) {
    const requesterId = String(
      requester?.userId || requester?.sub || requester?.id || "",
    ).trim();
    const isSelf = requesterId && requesterId === String(targetUserId);
    const isAdmin = String(requester?.role || "").toLowerCase() === "admin";
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException("Not authorized to view this history");
    }

    const versions = await this.auditModel
      .find({ userId: String(targetUserId) })
      .sort({ version: -1 })
      .limit(Math.min(50, Math.max(1, limit)))
      .select("version collaborationScore campaignReadiness trendstarzRecommended isPaid createdAt")
      .lean();

    const withDeltas = versions.map((entry: any, i: number) => ({
      version: entry.version,
      collaborationScore: entry.collaborationScore,
      campaignReadiness: entry.campaignReadiness,
      trendstarzRecommended: entry.trendstarzRecommended,
      isPaid: !!entry.isPaid,
      createdAt: entry.createdAt,
      scoreDelta:
        i + 1 < versions.length
          ? entry.collaborationScore - versions[i + 1].collaborationScore
          : null,
    }));

    return { history: withDeltas };
  }

  /**
   * A specific past audit version's full data — old versions are never
   * deleted (just superseded via isCurrent, see runAudit), so the Score
   * Center's history "View" can show the real historical snapshot rather
   * than just the summary line getAuditHistory returns. Self/admin only,
   * same guard as getAuditHistory.
   */
  async getAuditVersion(targetUserId: string, version: number, requester: any) {
    const requesterId = String(
      requester?.userId || requester?.sub || requester?.id || "",
    ).trim();
    const isSelf = requesterId && requesterId === String(targetUserId);
    const isAdmin = String(requester?.role || "").toLowerCase() === "admin";
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException("Not authorized to view this audit");
    }

    const audit: any = await this.auditModel
      .findOne({ userId: String(targetUserId), version })
      .lean();
    if (!audit) throw new NotFoundException("No audit found for that version");

    return audit;
  }

  /** Public — see CollaborationScoreController.getPlatformFlags for why only this one field is exposed unauthenticated. */
  async getPlatformFlags() {
    const settings = await this.settingsService.getSettings();
    return { platformsEnabled: settings.platformsEnabled };
  }

  /** Admin-only — every re-analysis payment for one creator, for the admin detail page. */
  async getReanalysisPayments(targetUserId: string, actor: any) {
    this.assertAdmin(actor);
    const payments = await this.paymentModel
      .find({ userId: toObjectId(targetUserId), purpose: "collab_score_reanalysis" })
      .sort({ createdAt: -1 })
      .select("amount paymentStatus status createdAt archivedAt")
      .lean();
    return {
      payments: payments.map((p: any) => ({
        amountRupees: Math.round((p.amount || 0) / 100),
        paymentStatus: p.paymentStatus,
        status: p.status,
        createdAt: p.createdAt,
        archived: !!p.archivedAt,
      })),
    };
  }

  async adminList(actor: any, query: any) {
    this.assertAdmin(actor);
    const page = Math.max(1, Number(query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit || 20)));
    const filter: any = { isCurrent: true };
    if (query?.userType) filter.userType = query.userType;
    if (query?.trendstarzRecommended !== undefined) {
      filter.trendstarzRecommended = query.trendstarzRecommended === "true";
    }
    if (query?.campaignReadiness) filter.campaignReadiness = query.campaignReadiness;
    if (query?.dateFrom || query?.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const [items, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.auditModel.countDocuments(filter),
    ]);

    const result: any = { items, total, page, limit };

    if (String(query?.summary) === "true") {
      const settings = await this.settingsService.getSettings();
      const trackAuditCost = settings.analytics.trackAuditCost;
      const summaryAgg = await this.auditModel.aggregate([
        { $match: { isCurrent: true } },
        {
          $group: {
            _id: null,
            totalAiCostUsd: { $sum: "$aiCostUsd" },
            totalAiInputTokens: { $sum: "$aiInputTokens" },
            totalAiOutputTokens: { $sum: "$aiOutputTokens" },
            aiAuditCount: { $sum: { $cond: ["$aiUsed", 1, 0] } },
            avgScore: { $avg: "$collaborationScore" },
            recommendedCount: { $sum: { $cond: ["$trendstarzRecommended", 1, 0] } },
          },
        },
      ]);
      result.summary = summaryAgg[0] || {
        totalAiCostUsd: 0,
        totalAiInputTokens: 0,
        totalAiOutputTokens: 0,
        aiAuditCount: 0,
        avgScore: 0,
        recommendedCount: 0,
      };
      if (!trackAuditCost) {
        result.summary.totalAiCostUsd = null;
        result.summary.totalAiInputTokens = null;
        result.summary.totalAiOutputTokens = null;
      }

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      // Every run created today, not just each user's current one — this is
      // a cost/volume counter, not a per-user snapshot.
      const todayAgg = await this.auditModel.aggregate([
        { $match: { createdAt: { $gte: startOfToday } } },
        {
          $group: {
            _id: null,
            audits: { $sum: 1 },
            aiCalls: { $sum: { $cond: ["$aiUsed", 1, 0] } },
            estimatedCostUsd: { $sum: "$aiCostUsd" },
            successCount: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            failureCount: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          },
        },
      ]);
      const today = todayAgg[0] || {
        audits: 0,
        aiCalls: 0,
        estimatedCostUsd: 0,
        successCount: 0,
        failureCount: 0,
      };

      // Same window as todayAgg above, just unwound per collected platform
      // instead of a flat count — one audit can (and usually does) contribute
      // to more than one platform's count. aiUsed/isPaid live on the audit
      // itself (not per platform), so they're just carried along on each
      // duplicated row the $unwind produces — correct either way, since
      // "this audit used AI" is true for every platform it collected.
      const platformAgg = await this.auditModel.aggregate([
        { $match: { createdAt: { $gte: startOfToday } } },
        { $unwind: "$platformsCollected" },
        {
          $group: {
            _id: "$platformsCollected.platform",
            count: { $sum: 1 },
            aiCount: { $sum: { $cond: ["$aiUsed", 1, 0] } },
            paidCount: { $sum: { $cond: ["$isPaid", 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
      ]);

      result.todaySummary = {
        ...today,
        averageCostUsd: today.aiCalls > 0 ? today.estimatedCostUsd / today.aiCalls : 0,
        platformBreakdown: platformAgg.map((p: any) => ({
          platform: p._id,
          count: p.count,
          aiCount: p.aiCount,
          paidCount: p.paidCount,
        })),
      };
      if (!trackAuditCost) {
        result.todaySummary.estimatedCostUsd = null;
        result.todaySummary.averageCostUsd = null;
      }
    }

    return result;
  }

  private oauthScopesFor(platform: "instagram" | "facebook"): string[] {
    if (platform === "instagram") {
      return ["pages_show_list", "instagram_basic", "instagram_manage_insights", "pages_read_engagement"];
    }
    return ["pages_show_list", "pages_read_engagement", "pages_read_user_content"];
  }

  private dashboardPathForRole(role: any): string {
    const normalized = String(role || "").toLowerCase();
    if (normalized === "brand") return "/brand-dashboard";
    if (normalized === "photographer") return "/photographer-dashboard";
    return "/influencer-dashboard";
  }

  /**
   * Signs a short-lived state param so the bare-browser callback (Meta
   * redirects with no Authorization header) still knows which user/role/
   * platform this connection is for — reuses the app's existing JWT secret
   * rather than standing up a session store.
   */
  getConnectAuthorizationUrl(userId: string, role: any, platform: "instagram" | "facebook") {
    if (platform !== "instagram" && platform !== "facebook") {
      throw new BadRequestException("Unsupported platform");
    }
    const state = jwt.sign({ userId: String(userId), role, platform }, getJwtSecret(), { expiresIn: "10m" });
    const authorizationUrl = this.metaOAuthService.getAuthorizationUrl(state, this.oauthScopesFor(platform));
    return { authorizationUrl };
  }

  /**
   * Exchanges the OAuth code, resolves the linked Facebook Page (and, for
   * Instagram, the Page's linked Instagram Business Account), and upserts
   * the SocialOAuthConnection. Returns a URL for the controller to redirect
   * the browser back to — never runs a new audit itself; the next
   * Re-Analyze is what picks up the newly connected platform's real data.
   */
  async handleOAuthCallback(code: string, state: string): Promise<string> {
    let decoded: { userId: string; role: any; platform: "instagram" | "facebook" };
    try {
      decoded = jwt.verify(state, getJwtSecret()) as any;
    } catch {
      throw new BadRequestException("Invalid or expired connect request. Please try again.");
    }

    const shortLived = await this.metaOAuthService.exchangeCodeForToken(code);
    const longLived = await this.metaOAuthService.exchangeForLongLivedToken(shortLived.accessToken);
    const pages = await this.metaOAuthService.resolveFacebookPages(longLived.accessToken);
    const page = pages[0]; // first Page — matches the common single-Page creator setup

    const expiresAt = longLived.expiresInSeconds
      ? new Date(Date.now() + longLived.expiresInSeconds * 1000)
      : null;

    // Display cache for the profile-edit/registration UI ("Username: ...",
    // "Followers: Auto Imported") — never used for scoring itself.
    let displayHandle: string | null = page?.name || null;
    let displayFollowers: number | null = page?.followersCount ?? null;
    if (decoded.platform === "instagram" && page?.instagramBusinessAccountId) {
      const igStats = await this.metaOAuthService.getInstagramBusinessAccountStats(
        page.instagramBusinessAccountId,
        longLived.accessToken,
      );
      if (igStats) {
        displayHandle = igStats.username;
        displayFollowers = igStats.followersCount;
      }
    }

    await this.connectionModel.findOneAndUpdate(
      { userId: decoded.userId, platform: decoded.platform },
      {
        $set: {
          userId: decoded.userId,
          userType: this.paymentUserType(decoded.role),
          platform: decoded.platform,
          accessToken: longLived.accessToken,
          longLivedTokenExpiresAt: expiresAt,
          facebookPageId: page?.id || null,
          instagramBusinessAccountId:
            decoded.platform === "instagram" ? page?.instagramBusinessAccountId || null : null,
          handle: displayHandle,
          followersCount: displayFollowers,
          scopes: this.oauthScopesFor(decoded.platform),
          connectedAt: new Date(),
          revokedAt: null,
        },
      },
      { upsert: true },
    );

    const dashboardPath = this.dashboardPathForRole(decoded.role);
    return `${process.env.FRONTEND_URL || "https://trendstarz.in"}${dashboardPath}?connected=${decoded.platform}`;
  }

  async disconnectPlatform(userId: string, platform: "instagram" | "facebook"): Promise<{ success: boolean }> {
    const connection: any = await this.connectionModel
      .findOne({ userId: String(userId), platform })
      .select("+accessToken");
    if (connection) {
      const targetId = platform === "instagram" ? connection.instagramBusinessAccountId : connection.facebookPageId;
      if (targetId && connection.accessToken) {
        await this.metaOAuthService.revokePermissions(targetId, connection.accessToken);
      }
      await this.connectionModel.deleteOne({ _id: connection._id });
    }
    return { success: true };
  }

  async getConnections(userId: string): Promise<{
    instagram: SocialConnectionDetail | null;
    facebook: SocialConnectionDetail | null;
  }> {
    const connections = await this.connectionModel
      .find({ userId: String(userId), revokedAt: null })
      .select("platform handle followersCount connectedAt")
      .lean();
    const byPlatform = new Map(connections.map((c: any) => [c.platform, c]));
    const toDetail = (platform: string): SocialConnectionDetail | null => {
      const c: any = byPlatform.get(platform);
      if (!c) return null;
      return { handle: c.handle || null, followersCount: c.followersCount ?? null, connectedAt: c.connectedAt };
    };
    return { instagram: toDetail("instagram"), facebook: toDetail("facebook") };
  }
}
