import {
  CollaborationScoreRulesService,
  ComputeScoresInput,
} from "./collaboration-score-rules.service";

describe("CollaborationScoreRulesService", () => {
  let service: CollaborationScoreRulesService;

  const settings = {
    weights: {
      contentQuality: { rulesPercent: 60, aiPercent: 40 },
      professionalBranding: { rulesPercent: 70, aiPercent: 30 },
    },
    thresholds: {
      trendstarzRecommendedMinScore: 80,
      campaignReadyMinScore: 70,
      partiallyReadyMinScore: 40,
    },
    scoreWeights: {
      profileCompletion: 15,
      contentQuality: 25,
      postingConsistency: 20,
      professionalBranding: 20,
      campaignReadiness: 20,
    },
  };

  const baseInput = (overrides: Partial<ComputeScoresInput> = {}): ComputeScoresInput => ({
    profile: {},
    userType: "Influencer",
    completion: 100,
    flags: [],
    eligibility: { eligible: true, blockers: [] },
    collectedPlatforms: [],
    settings,
    aiResult: null,
    ...overrides,
  });

  beforeEach(() => {
    service = new CollaborationScoreRulesService();
  });

  it("weights the five criteria at 15/25/20/20/20 and rounds the total", () => {
    // A fully complete, fully eligible profile with no collected platforms
    // (so contentQuality/postingConsistency both bottom out at 0) isolates
    // the weighting arithmetic to just completeness (15%) + branding (20%)
    // + campaignReadiness (20%), which we can hand-verify.
    const input = baseInput({
      completion: 100,
      profile: {
        profileImages: [{ url: "https://cdn/img.jpg" }],
        description: "A".repeat(90),
        categories: ["Fashion"],
        socialMedia: [{ contentTypes: [{ enabled: true, price: 500 }] }],
        payout: { upiId: "creator@upi" },
      },
      eligibility: { eligible: true, blockers: [] },
    });

    const result = service.computeScores(input);

    expect(result.profileCompletenessScore).toBe(100);
    expect(result.contentQualityScore).toBe(0); // no platforms collected
    expect(result.postingConsistencyScore).toBe(0); // no platforms collected
    expect(result.professionalBrandingScore).toBeGreaterThanOrEqual(90);
    expect(result.campaignReadinessScore).toBe(100); // eligible, no open High flags

    const w = settings.scoreWeights;
    const expectedTotal = Math.round(
      (w.profileCompletion / 100) * result.profileCompletenessScore +
        (w.contentQuality / 100) * result.contentQualityScore +
        (w.postingConsistency / 100) * result.postingConsistencyScore +
        (w.professionalBranding / 100) * result.professionalBrandingScore +
        (w.campaignReadiness / 100) * result.campaignReadinessScore,
    );
    expect(result.collaborationScore).toBe(expectedTotal);
  });

  it("never lets AI drive campaignReadinessScore — stays fully deterministic", () => {
    const withAi = service.computeScores(
      baseInput({
        eligibility: { eligible: true, blockers: [] },
        aiResult: {
          captionQuality: { score: 100, notes: "" },
          brandSafety: { score: 100, riskFlags: [], notes: "" },
          contentCategory: { primary: "Fashion", secondary: [], confidence: 1 },
          visualBrandingNotes: "",
          postingToneConsistency: { score: 100, notes: "" },
          overallContentQualityScore: 100,
          strengths: [],
          improvements: [],
        },
      }),
    );
    const withoutAi = service.computeScores(
      baseInput({ eligibility: { eligible: true, blockers: [] }, aiResult: null }),
    );
    expect(withAi.campaignReadinessScore).toBe(withoutAi.campaignReadinessScore);
  });

  it("redistributes the AI share to rules when aiResult is null (no blank gap)", () => {
    const platform: any = {
      platform: "YouTube",
      method: "API",
      handle: "test",
      followersOrSubscribers: 10000,
      recentPosts: [
        { title: "a", description: "", publishedAt: new Date(), views: 1000, likes: 100, comments: 20 },
      ],
      collectedAt: new Date(),
      raw: {},
      confidence: 95,
      confidenceReason: "",
    };
    const result = service.computeScores(
      baseInput({ collectedPlatforms: [platform], aiResult: null }),
    );
    // rulesScore for 12% engagement rate ((100+20)/1000) maps to the 100 bucket
    expect(result.contentQualityScore).toBe(100);
  });

  it("derives campaignReadiness label from the admin-configured thresholds", () => {
    const readyInput = baseInput({
      completion: 100,
      profile: {
        profileImages: [{ url: "x" }],
        description: "A".repeat(90),
        categories: ["Fashion"],
        socialMedia: [{ contentTypes: [{ enabled: true, price: 500 }] }],
        payout: { upiId: "x" },
      },
      collectedPlatforms: [
        {
          platform: "YouTube",
          method: "API",
          handle: "x",
          followersOrSubscribers: 50000,
          recentPosts: Array.from({ length: 10 }, (_, i) => ({
            title: "t",
            description: "",
            publishedAt: new Date(Date.now() - i * 5 * 24 * 60 * 60 * 1000),
            views: 10000,
            likes: 800,
            comments: 200,
          })),
          collectedAt: new Date(),
          raw: {},
          confidence: 95,
          confidenceReason: "",
        },
      ],
      eligibility: { eligible: true, blockers: [] },
    });
    const result = service.computeScores(readyInput);
    expect(result.campaignReadiness).toBe("Campaign Ready");
    expect(result.trendstarzRecommended).toBe(
      result.collaborationScore >= settings.thresholds.trendstarzRecommendedMinScore,
    );

    const notReadyInput = baseInput({
      completion: 0,
      eligibility: { eligible: false, blockers: ["Profile incomplete", "Admin approval required"] },
    });
    const notReady = service.computeScores(notReadyInput);
    expect(notReady.campaignReadiness).not.toBe("Campaign Ready");
    expect(notReady.trendstarzRecommended).toBe(false);
  });

  it("only computes portfolioScore for Photographer, and keeps it separate from the total", () => {
    const photographer = service.computeScores(
      baseInput({
        userType: "Photographer",
        profile: { portfolio: "https://example.com/portfolio", skills: ["Reels", "Drone"], equipment: ["Sony"] },
      }),
    );
    expect(photographer.portfolioScore).not.toBeNull();

    const influencer = service.computeScores(baseInput({ userType: "Influencer" }));
    expect(influencer.portfolioScore).toBeNull();
  });

  it("caps self-reported (unverified) platform data below fully-verified API data", () => {
    const selfReported = service.computeScores(
      baseInput({
        collectedPlatforms: [
          {
            platform: "Instagram",
            method: "SELF_REPORTED",
            handle: "x",
            followersOrSubscribers: 10000,
            recentPosts: [],
            collectedAt: new Date(),
            raw: { avgLikes: 100, avgComments: 10 },
            confidence: 35,
            confidenceReason: "",
          },
        ],
      }),
    );
    expect(selfReported.contentQualityScore).toBeLessThanOrEqual(50);
  });

  describe("computePreviewScores — anonymous preview never returns NaN", () => {
    it("returns 0, not NaN, when a platform's data would otherwise produce an invalid computation", () => {
      const platform: any = {
        platform: "YouTube",
        method: "API",
        handle: "test",
        followersOrSubscribers: 1000,
        // An Invalid Date's getTime() is NaN — this must not leak through
        // to previewScore (see youtube-collector.service.ts's guard too).
        recentPosts: [{ title: "a", description: "", publishedAt: new Date(NaN), views: 100, likes: 10, comments: 1 }],
        collectedAt: new Date(),
        raw: {},
        confidence: 95,
        confidenceReason: "",
      };

      const result = service.computePreviewScores([platform], settings);

      expect(Number.isFinite(result.previewScore)).toBe(true);
      expect(Number.isFinite(result.contentQualityScore)).toBe(true);
      expect(Number.isFinite(result.postingConsistencyScore)).toBe(true);
    });

    it("computes a real, finite score for a normal, healthy channel", () => {
      const platform: any = {
        platform: "YouTube",
        method: "API",
        handle: "test",
        followersOrSubscribers: 5000,
        recentPosts: Array.from({ length: 5 }, (_, i) => ({
          title: "a",
          description: "",
          publishedAt: new Date(Date.now() - i * 5 * 24 * 60 * 60 * 1000),
          views: 1000,
          likes: 100,
          comments: 20,
        })),
        collectedAt: new Date(),
        raw: {},
        confidence: 95,
        confidenceReason: "",
      };

      const result = service.computePreviewScores([platform], settings);

      expect(result.previewScore).toBeGreaterThan(0);
      expect(Number.isFinite(result.previewScore)).toBe(true);
    });
  });

  describe("platformMiniScore — per-platform Content Quality + Posting Consistency in isolation", () => {
    it("renormalizes 55/45 between just Content Quality and Posting Consistency for one platform", () => {
      // High engagement (>=8%) -> contentQualityForPlatform 100; posted
      // within the last 60 days with low gap variance -> postingConsistency
      // near 100 too. 0.55*100 + 0.45*100 = 100.
      const platform: any = {
        platform: "YouTube",
        method: "API",
        handle: "test",
        followersOrSubscribers: 5000,
        recentPosts: Array.from({ length: 5 }, (_, i) => ({
          title: "a",
          description: "",
          publishedAt: new Date(Date.now() - i * 2 * 24 * 60 * 60 * 1000),
          views: 1000,
          likes: 100,
          comments: 20,
        })),
        collectedAt: new Date(),
        raw: {},
        confidence: 95,
        confidenceReason: "",
      };

      expect(service.platformMiniScore(platform)).toBe(100);
    });

    it("caps self-reported platforms the same way contentQualityForPlatform/postingConsistencyForPlatform already do", () => {
      const platform: any = {
        platform: "Instagram",
        method: "SELF_REPORTED",
        handle: "test",
        followersOrSubscribers: 1000,
        recentPosts: [],
        collectedAt: new Date(),
        raw: { avgLikes: null, avgComments: null },
        confidence: 0,
        confidenceReason: "",
      };

      // contentQualityForPlatform: incomplete self-reported stats -> 20.
      // postingConsistencyForPlatform: flat 50 for any self-reported platform.
      // 0.55*20 + 0.45*50 = 33.5 -> 34 (rounds up).
      expect(service.platformMiniScore(platform)).toBe(34);
    });

    it("is 0 for a platform with no posts and no data", () => {
      const platform: any = {
        platform: "YouTube",
        method: "API",
        handle: "test",
        followersOrSubscribers: 0,
        recentPosts: [],
        collectedAt: new Date(),
        raw: {},
        confidence: 30,
        confidenceReason: "",
      };

      expect(service.platformMiniScore(platform)).toBe(0);
    });
  });
});
