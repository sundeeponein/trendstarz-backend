import { CollaborationScoreService } from "./collaboration-score.service";

describe("CollaborationScoreService", () => {
  let service: CollaborationScoreService;
  let auditModel: any;
  let influencerModel: any;
  let brandModel: any;
  let photographerModel: any;
  let profileVerificationService: any;
  let rulesService: any;
  let aiService: any;
  let settingsService: any;
  let paymentModel: any;
  let transactionModel: any;
  let razorpayService: any;
  let youtubeCollector: any;

  const fakeProfile = {
    _id: "user-1",
    profileImages: [{ url: "https://cdn/img.jpg" }],
    socialMedia: [{ platform: "YouTube", handle: "test" }],
    categories: ["Fashion"],
    payout: { upiId: "x@upi" },
  };

  const createdDoc = {
    toObject: () => ({ collaborationScore: 0, aiUsed: false, aiAnalysis: null }),
  };

  beforeEach(() => {
    auditModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
        lean: jest.fn().mockResolvedValue(null),
      }),
      updateOne: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue(createdDoc),
      find: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn(),
    };
    influencerModel = {
      findById: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(fakeProfile) }),
      updateOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
    };
    brandModel = { findById: jest.fn(), updateOne: jest.fn(), findByIdAndUpdate: jest.fn() };
    photographerModel = { findById: jest.fn(), updateOne: jest.fn(), findByIdAndUpdate: jest.fn() };

    profileVerificationService = {
      getCompletionSnapshot: jest.fn().mockResolvedValue({
        userType: "Influencer",
        completion: 80,
        flags: [],
      }),
      buildEligibility: jest.fn().mockReturnValue({ eligible: true, blockers: [] }),
    };
    rulesService = {
      computeScores: jest.fn().mockReturnValue({
        profileCompletenessScore: 80,
        contentQualityScore: 0,
        postingConsistencyScore: 0,
        professionalBrandingScore: 50,
        campaignReadinessScore: 100,
        collaborationScore: 60,
        portfolioScore: null,
        campaignReadiness: "Partially Ready",
        trendstarzRecommended: false,
        pricingSuggestion: { reelPrice: 1500, storyPrice: 600, videoPrice: 2700, currency: "INR", basis: "" },
        categoryMatch: ["Fashion"],
        strengths: [],
        improvements: [],
        recommendations: [],
      }),
      computePreviewScores: jest.fn().mockReturnValue({
        contentQualityScore: 60,
        postingConsistencyScore: 50,
        previewScore: 56,
      }),
    };
    aiService = { analyzeContentSync: jest.fn() };
    settingsService = {
      getSettings: jest.fn().mockResolvedValue({
        aiEnabled: false,
        aiModel: "claude-sonnet-5",
        anonymousPreviewEnabled: true,
        freeAuditCount: 1,
        platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
        reanalysisCooldownDays: 0,
        reanalysisFeeRupees: 99,
        analytics: {
          trackAuditCost: true,
          trackAverageScore: true,
          trackPlatformUsage: true,
          trackAuditHistory: true,
        },
      }),
    };
    paymentModel = {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
    };
    transactionModel = { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}) };
    razorpayService = {
      createOrder: jest.fn().mockResolvedValue({ orderId: "order_1", amount: 9900, currency: "INR", keyId: "key_1" }),
      verifySignature: jest.fn().mockReturnValue(true),
    };
    youtubeCollector = { platform: "YouTube" as const, collect: jest.fn().mockResolvedValue(null) };
    const instagramCollector = { platform: "Instagram" as const, collect: jest.fn().mockResolvedValue(null) };
    const facebookCollector = { platform: "Facebook" as const, collect: jest.fn().mockResolvedValue(null) };
    const linkedinCollector = { platform: "LinkedIn" as const, collect: jest.fn().mockResolvedValue(null) };

    service = new CollaborationScoreService(
      auditModel,
      influencerModel,
      brandModel,
      photographerModel,
      paymentModel,
      transactionModel,
      profileVerificationService,
      rulesService,
      aiService,
      settingsService,
      razorpayService,
      youtubeCollector,
      instagramCollector,
      facebookCollector,
      linkedinCollector,
    );
  });

  it("never writes to the Influencer/Brand/Photographer collections — reads only", async () => {
    await service.runAudit("user-1", "influencer", "USER");

    expect(influencerModel.findById).toHaveBeenCalled();
    expect(influencerModel.updateOne).not.toHaveBeenCalled();
    expect(influencerModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(brandModel.updateOne).not.toHaveBeenCalled();
    expect(photographerModel.updateOne).not.toHaveBeenCalled();
  });

  it("never calls the AI service when aiEnabled is false, and persists aiUsed:false/aiAnalysis:null", async () => {
    await service.runAudit("user-1", "influencer", "USER");

    expect(aiService.analyzeContentSync).not.toHaveBeenCalled();
    const createCallArg = auditModel.create.mock.calls[0][0];
    expect(createCallArg.aiUsed).toBe(false);
    expect(createCallArg.aiAnalysis).toBeNull();
    expect(createCallArg.aiModel).toBeNull();
  });

  it("calls the AI service when aiEnabled is true, and threads its result into the rules computation", async () => {
    settingsService.getSettings.mockResolvedValue({
      aiEnabled: true,
      aiModel: "claude-sonnet-5",
      anonymousPreviewEnabled: true,
      freeAuditCount: 1,
      platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
      reanalysisCooldownDays: 0,
      reanalysisFeeRupees: 99,
      analytics: { trackAuditCost: true, trackAverageScore: true, trackPlatformUsage: true, trackAuditHistory: true },
    });
    const aiResult = {
      captionQuality: { score: 80, notes: "" },
      brandSafety: { score: 100, riskFlags: [], notes: "" },
      contentCategory: { primary: "Fashion", secondary: [], confidence: 0.9 },
      visualBrandingNotes: "",
      postingToneConsistency: { score: 70, notes: "" },
      overallContentQualityScore: 75,
      strengths: [],
      improvements: [],
    };
    aiService.analyzeContentSync.mockResolvedValue({
      result: aiResult,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    });

    await service.runAudit("user-1", "influencer", "USER");

    expect(aiService.analyzeContentSync).toHaveBeenCalledTimes(1);
    const computeArg = rulesService.computeScores.mock.calls[0][0];
    expect(computeArg.aiResult).toEqual(aiResult);
    const createCallArg = auditModel.create.mock.calls[0][0];
    expect(createCallArg.aiUsed).toBe(true);
    expect(createCallArg.aiCostUsd).toBe(0.001);
  });

  it("increments version and marks the previous audit non-current instead of overwriting history", async () => {
    auditModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: "old-doc", version: 3, isCurrent: true }),
    });

    await service.runAudit("user-1", "influencer", "USER");

    expect(auditModel.updateOne).toHaveBeenCalledWith(
      { _id: "old-doc" },
      { $set: { isCurrent: false } },
    );
    const createCallArg = auditModel.create.mock.calls[0][0];
    expect(createCallArg.version).toBe(4);
    expect(createCallArg.isCurrent).toBe(true);
  });

  describe("paid re-analysis gating", () => {
    it("allows a direct run when no prior audit exists (first audit is free)", async () => {
      await expect(service.runAudit("user-1", "influencer", "USER")).resolves.toBeDefined();
      expect(auditModel.create).toHaveBeenCalled();
    });

    it("rejects a direct run with 402 once a prior audit already exists", async () => {
      auditModel.countDocuments.mockResolvedValue(1);

      await expect(service.runAudit("user-1", "influencer", "USER")).rejects.toMatchObject({
        status: 402,
      });
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it("skipFreeGate lets the paid-verification path run a 2nd+ audit", async () => {
      auditModel.countDocuments.mockResolvedValue(1);

      await expect(
        service.runAudit("user-1", "influencer", "USER", { skipFreeGate: true }),
      ).resolves.toBeDefined();
      expect(auditModel.create).toHaveBeenCalled();
    });

    it("admin/nightly triggers are exempt from the free-audit gate", async () => {
      auditModel.countDocuments.mockResolvedValue(1);

      await expect(service.runAudit("user-1", "influencer", "ADMIN")).resolves.toBeDefined();
      await expect(service.runAudit("user-1", "influencer", "SYSTEM_NIGHTLY")).resolves.toBeDefined();
    });

    it("respects an admin-raised freeAuditCount — a 2nd audit is still free when the limit is 2", async () => {
      settingsService.getSettings.mockResolvedValue({
        aiEnabled: false,
        aiModel: "claude-sonnet-5",
        anonymousPreviewEnabled: true,
        freeAuditCount: 2,
        platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
        reanalysisCooldownDays: 0,
        reanalysisFeeRupees: 99,
        analytics: { trackAuditCost: true, trackAverageScore: true, trackPlatformUsage: true, trackAuditHistory: true },
      });
      auditModel.countDocuments.mockResolvedValue(1); // one prior audit already

      await expect(service.runAudit("user-1", "influencer", "USER")).resolves.toBeDefined();

      auditModel.countDocuments.mockResolvedValue(2); // now at the limit
      await expect(service.runAudit("user-1", "influencer", "USER")).rejects.toMatchObject({ status: 402 });
    });

    it("createReanalysisOrder rejects while the cooldown hasn't elapsed", async () => {
      settingsService.getSettings.mockResolvedValue({
        aiEnabled: false,
        aiModel: "claude-sonnet-5",
        anonymousPreviewEnabled: true,
        freeAuditCount: 1,
        platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
        reanalysisCooldownDays: 30,
        reanalysisFeeRupees: 99,
        analytics: { trackAuditCost: true, trackAverageScore: true, trackPlatformUsage: true, trackAuditHistory: true },
      });
      auditModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ createdAt: new Date() }),
        }),
      });

      await expect(service.createReanalysisOrder("user-1", "influencer")).rejects.toThrow(
        "You can re-analyze again on",
      );
      expect(razorpayService.createOrder).not.toHaveBeenCalled();
    });

    it("createReanalysisOrder dedupes stale pending orders and creates a fresh Razorpay order at the configured fee", async () => {
      const result = await service.createReanalysisOrder("507f1f77bcf86cd799439011", "influencer");

      expect(paymentModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "collab_score_reanalysis", status: "pending" }),
      );
      expect(razorpayService.createOrder).toHaveBeenCalledWith(9900, expect.any(Object));
      expect(paymentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "collab_score_reanalysis", orderId: "order_1" }),
      );
      expect(result).toEqual({ order: { orderId: "order_1", amount: 9900, currency: "INR", keyId: "key_1" } });
    });

    it("verifyReanalysisPayment rejects an invalid signature with no DB writes", async () => {
      razorpayService.verifySignature.mockReturnValue(false);

      await expect(
        service.verifyReanalysisPayment("user-1", "influencer", {
          orderId: "order_1",
          paymentId: "pay_1",
          signature: "bad",
        }),
      ).rejects.toThrow("Invalid payment signature");
      expect(paymentModel.findOne).not.toHaveBeenCalled();
    });

    it("verifyReanalysisPayment captures payment then runs a real audit with skipFreeGate", async () => {
      const payment: any = {
        paymentStatus: "created",
        status: "pending",
        save: jest.fn().mockResolvedValue({}),
      };
      paymentModel.findOne.mockResolvedValue(payment);
      auditModel.countDocuments.mockResolvedValue(1);
      auditModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ userId: "507f1f77bcf86cd799439011", collaborationScore: 82 }),
      });

      const result = await service.verifyReanalysisPayment("507f1f77bcf86cd799439011", "influencer", {
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "good",
      });

      expect(payment.paymentStatus).toBe("captured");
      expect(payment.status).toBe("approved");
      expect(payment.save).toHaveBeenCalled();
      expect(transactionModel.updateMany).toHaveBeenCalled();
      expect(auditModel.create).toHaveBeenCalled(); // the skipFreeGate runAudit call
      expect(result).toMatchObject({ userId: "507f1f77bcf86cd799439011" });
    });

    it("verifyReanalysisPayment is idempotent on a repeat call for an already-captured payment", async () => {
      const payment: any = { paymentStatus: "captured", status: "approved", save: jest.fn() };
      paymentModel.findOne.mockResolvedValue(payment);
      auditModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ userId: "507f1f77bcf86cd799439011", collaborationScore: 82 }),
      });

      await service.verifyReanalysisPayment("507f1f77bcf86cd799439011", "influencer", {
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "good",
      });

      expect(payment.save).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });
  });

  describe("getAuditForUser — brand-safe filtering", () => {
    const fullAudit = {
      userId: "user-1",
      userType: "Influencer",
      collaborationScore: 82,
      campaignReadiness: "Campaign Ready",
      trendstarzRecommended: true,
      pricingSuggestion: { reelPrice: 1500 },
      categoryMatch: ["Fashion"],
      portfolioScore: null,
      createdAt: new Date(),
      aiAnalysis: { visualBrandingNotes: "secret sauce" },
      profileCompletenessScore: 90,
      platformsCollected: [{ raw: { secretApiData: true } }],
      aiInputTokens: 1234,
    };

    beforeEach(() => {
      auditModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(fullAudit) });
    });

    it("returns full detail to the profile owner", async () => {
      const result = await service.getAuditForUser("user-1", { userId: "user-1", role: "influencer" });
      expect(result).toEqual({ ...fullAudit, canReanalyze: true, reanalysisAvailableAt: null, reanalysisFeeRupees: 99 });
    });

    it("returns full detail to admins", async () => {
      const result = await service.getAuditForUser("user-1", { userId: "admin-1", role: "admin" });
      expect(result).toEqual({ ...fullAudit, canReanalyze: true, reanalysisAvailableAt: null, reanalysisFeeRupees: 99 });
    });

    it("strips AI analysis, raw platform data, and sub-scores from a brand-role caller", async () => {
      const result: any = await service.getAuditForUser("user-1", { userId: "brand-1", role: "brand" });
      expect(result.aiAnalysis).toBeUndefined();
      expect(result.platformsCollected).toBeUndefined();
      expect(result.aiInputTokens).toBeUndefined();
      expect(result.profileCompletenessScore).toBeUndefined();
      expect(result.collaborationScore).toBe(82);
      expect(result.campaignReadiness).toBe("Campaign Ready");
      expect(result.trendstarzRecommended).toBe(true);
      expect(result.pricingSuggestion).toEqual({ reelPrice: 1500 });
      expect(result.categoryMatch).toEqual(["Fashion"]);
    });
  });

  describe("previewFromYoutubeUrl — anonymous, pre-registration teaser", () => {
    it("throws when no URL is given", async () => {
      await expect(service.previewFromYoutubeUrl("")).rejects.toThrow(
        "A YouTube channel URL is required",
      );
    });

    it("throws when the collector can't find a public channel", async () => {
      youtubeCollector.collect.mockResolvedValue(null);
      await expect(service.previewFromYoutubeUrl("https://youtube.com/@nope")).rejects.toThrow(
        "Could not find a public YouTube channel",
      );
    });

    it("respects the anonymousPreviewEnabled kill switch — never calls the collector when off", async () => {
      settingsService.getSettings.mockResolvedValue({
        aiEnabled: false,
        aiModel: "claude-sonnet-5",
        anonymousPreviewEnabled: false,
        freeAuditCount: 1,
        platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
        reanalysisCooldownDays: 0,
        reanalysisFeeRupees: 99,
        analytics: { trackAuditCost: true, trackAverageScore: true, trackPlatformUsage: true, trackAuditHistory: true },
      });

      await expect(service.previewFromYoutubeUrl("https://youtube.com/@test")).rejects.toThrow(
        "currently unavailable",
      );
      expect(youtubeCollector.collect).not.toHaveBeenCalled();
    });

    it("never touches the audit collection — nothing persisted for anonymous lookups", async () => {
      youtubeCollector.collect.mockResolvedValue({
        platform: "YouTube",
        method: "API",
        handle: "test",
        followersOrSubscribers: 1000,
        recentPosts: [],
        collectedAt: new Date(),
        raw: {},
        confidence: 55,
        confidenceReason: "Public channel found, but very few recent uploads to analyze.",
      });

      const result = await service.previewFromYoutubeUrl("https://youtube.com/@test");

      expect(auditModel.create).not.toHaveBeenCalled();
      expect(result.platform).toBe("YouTube");
      expect(result.handle).toBe("test");
      expect(result.confidence).toBe(55);
      expect(typeof result.previewScore).toBe("number");
    });
  });

  describe("adminList — analytics.trackAuditCost gating", () => {
    beforeEach(() => {
      auditModel.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });
      auditModel.countDocuments.mockResolvedValue(0);
      auditModel.aggregate.mockResolvedValue([
        {
          totalAiCostUsd: 12.5,
          totalAiInputTokens: 100,
          totalAiOutputTokens: 50,
          aiAuditCount: 3,
          avgScore: 70,
          recommendedCount: 1,
          audits: 5,
          aiCalls: 3,
          estimatedCostUsd: 12.5,
          successCount: 5,
          failureCount: 0,
        },
      ]);
    });

    it("nulls out cost fields when trackAuditCost is off", async () => {
      settingsService.getSettings.mockResolvedValue({
        aiEnabled: false,
        aiModel: "claude-sonnet-5",
        anonymousPreviewEnabled: true,
        freeAuditCount: 1,
        platformsEnabled: { instagram: true, youtube: true, facebook: true, linkedin: true },
        reanalysisCooldownDays: 0,
        reanalysisFeeRupees: 99,
        analytics: { trackAuditCost: false, trackAverageScore: true, trackPlatformUsage: true, trackAuditHistory: true },
      });

      const result = await service.adminList({ role: "admin" }, { summary: "true" });

      expect(result.summary.totalAiCostUsd).toBeNull();
      expect(result.todaySummary.estimatedCostUsd).toBeNull();
      expect(result.todaySummary.averageCostUsd).toBeNull();
      expect(result.summary.avgScore).toBe(70); // unaffected — only cost fields are gated
    });

    it("keeps cost fields populated when trackAuditCost is on", async () => {
      const result = await service.adminList({ role: "admin" }, { summary: "true" });

      expect(result.summary.totalAiCostUsd).toBe(12.5);
      expect(result.todaySummary.estimatedCostUsd).toBe(12.5);
    });
  });
});
