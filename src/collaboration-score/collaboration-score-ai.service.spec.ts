import { CollaborationScoreAiService } from "./collaboration-score-ai.service";

const mockCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

describe("CollaborationScoreAiService", () => {
  let service: CollaborationScoreAiService;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    service = new CollaborationScoreAiService();
    mockCreate.mockReset();
  });

  afterAll(() => {
    process.env.ANTHROPIC_API_KEY = originalEnv;
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const freshService = new CollaborationScoreAiService();
    await expect(
      freshService.analyzeContentSync({
        userId: "u1",
        bioText: "",
        categories: [],
        platforms: [],
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("requests model claude-sonnet-5 with a json_schema output_config and no thinking config", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await service.analyzeContentSync({
      userId: "u1",
      bioText: "Fashion creator",
      categories: ["Fashion"],
      platforms: [],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const requestArg = mockCreate.mock.calls[0][0];
    expect(requestArg.model).toBe("claude-sonnet-5");
    expect(requestArg.thinking).toBeUndefined();
    expect(requestArg.output_config.format.type).toBe("json_schema");
    expect(requestArg.output_config.format.schema.additionalProperties).toBe(false);
  });

  it("parses the structured JSON response and computes token cost from usage", async () => {
    const parsedResult = {
      captionQuality: { score: 80, notes: "Good" },
      brandSafety: { score: 100, riskFlags: [], notes: "" },
      contentCategory: { primary: "Fashion", secondary: [], confidence: 0.9 },
      visualBrandingNotes: "Consistent bio tone.",
      postingToneConsistency: { score: 70, notes: "" },
      overallContentQualityScore: 75,
      strengths: ["Clear niche"],
      improvements: ["Post more often"],
    };
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(parsedResult) }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    });

    const call = await service.analyzeContentSync({
      userId: "u1",
      bioText: "",
      categories: [],
      platforms: [],
    });

    expect(call.result).toEqual(parsedResult);
    expect(call.inputTokens).toBe(1000);
    expect(call.outputTokens).toBe(200);
    // 1000 * (3/1e6) + 200 * (15/1e6) = 0.003 + 0.003 = 0.006
    expect(call.costUsd).toBeCloseTo(0.006, 6);
  });
});
