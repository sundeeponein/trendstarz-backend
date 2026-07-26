import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { CollectedPlatformData } from "./collectors/collector.interface";
import { AiAnalysisResult } from "./collaboration-score-rules.service";

const MODEL_ID = "claude-sonnet-5";

// Rough per-token USD pricing for cost logging (admin's "View AI Cost").
// claude-sonnet-5: $3.00 / 1M input, $15.00 / 1M output.
const INPUT_COST_PER_TOKEN = 3.0 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15.0 / 1_000_000;

const CONTENT_ANALYSIS_SYSTEM_PROMPT = `You are a marketplace profile analyst for TrendStarz, a platform connecting brands with influencers, photographers, and videographers. You are given text-only public content (post/video titles, descriptions, and profile bio text) — no images. Score the creator's content quality, brand safety, category fit, and posting-tone consistency based only on this text. Be strict and consistent: the same quality of content should always receive the same scores. Never invent facts not present in the input. Output must conform exactly to the provided JSON schema.`;

const CONTENT_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    captionQuality: {
      type: "object",
      properties: {
        score: { type: "integer" },
        notes: { type: "string" },
      },
      required: ["score", "notes"],
      additionalProperties: false,
    },
    brandSafety: {
      type: "object",
      properties: {
        score: { type: "integer" },
        riskFlags: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
      required: ["score", "riskFlags", "notes"],
      additionalProperties: false,
    },
    contentCategory: {
      type: "object",
      properties: {
        primary: { type: "string" },
        secondary: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
      },
      required: ["primary", "secondary", "confidence"],
      additionalProperties: false,
    },
    visualBrandingNotes: { type: "string" },
    postingToneConsistency: {
      type: "object",
      properties: {
        score: { type: "integer" },
        notes: { type: "string" },
      },
      required: ["score", "notes"],
      additionalProperties: false,
    },
    overallContentQualityScore: { type: "integer" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
  },
  required: [
    "captionQuality",
    "brandSafety",
    "contentCategory",
    "visualBrandingNotes",
    "postingToneConsistency",
    "overallContentQualityScore",
    "strengths",
    "improvements",
  ],
  additionalProperties: false,
} as const;

export interface ContentAnalysisInput {
  userId: string;
  bioText: string;
  categories: string[];
  platforms: CollectedPlatformData[];
}

export interface AiCallResult {
  result: AiAnalysisResult;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function buildUserPrompt(input: ContentAnalysisInput): string {
  const postsText = input.platforms
    .flatMap((p) =>
      p.recentPosts.slice(0, 10).map(
        (post) => `[${p.platform}] "${post.title}" — ${post.description}`.trim(),
      ),
    )
    .join("\n");

  return [
    `Bio: ${input.bioText || "(none provided)"}`,
    `Declared categories: ${input.categories.join(", ") || "(none)"}`,
    `Recent post titles/descriptions:`,
    postsText || "(no recent posts collected)",
  ].join("\n\n");
}

function computeCost(usage: { input_tokens: number; output_tokens: number }): number {
  return (
    usage.input_tokens * INPUT_COST_PER_TOKEN + usage.output_tokens * OUTPUT_COST_PER_TOKEN
  );
}

/**
 * Anthropic SDK wrapper — mirrors src/payment/razorpay.service.ts's lazy
 * getClient() pattern. Only ever called when
 * collaboration_score_settings.aiEnabled is true (see
 * collaboration-score.service.ts) — this is the cost safety valve.
 */
@Injectable()
export class CollaborationScoreAiService {
  private client: Anthropic | null = null;
  private readonly logger = new Logger(CollaborationScoreAiService.name);

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY in environment variables. Please check your .env file.",
      );
    }
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  /** Sync path — used for the on-demand "Re-Analyze" button (one profile). */
  async analyzeContentSync(input: ContentAnalysisInput): Promise<AiCallResult> {
    const client = this.getClient();
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 2048,
      system: CONTENT_ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
      output_config: {
        format: { type: "json_schema", schema: CONTENT_ANALYSIS_JSON_SCHEMA },
      },
    } as any);

    const textBlock = (response.content || []).find(
      (block: any) => block.type === "text",
    ) as any;
    const parsed: AiAnalysisResult = JSON.parse(textBlock?.text ?? "{}");
    const usage = (response as any).usage || { input_tokens: 0, output_tokens: 0 };

    return {
      result: parsed,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      costUsd: computeCost(usage),
    };
  }

  /**
   * Batch path — for the nightly re-audit job (Phase C). 50% cheaper, async;
   * never used for the synchronous "Re-Analyze" click.
   */
  async submitBatch(inputs: ContentAnalysisInput[]): Promise<string> {
    const client = this.getClient();
    const batch = await (client.messages as any).batches.create({
      requests: inputs.map((input) => ({
        custom_id: input.userId,
        params: {
          model: MODEL_ID,
          max_tokens: 2048,
          system: CONTENT_ANALYSIS_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(input) }],
          output_config: {
            format: { type: "json_schema", schema: CONTENT_ANALYSIS_JSON_SCHEMA },
          },
        },
      })),
    });
    return batch.id;
  }

  async pollBatchResults(
    batchId: string,
  ): Promise<Map<string, AiCallResult> | null> {
    const client = this.getClient();
    const batch = await (client.messages as any).batches.retrieve(batchId);
    if (batch.processing_status !== "ended") return null;

    const results = new Map<string, AiCallResult>();
    for await (const entry of (client.messages as any).batches.results(batchId)) {
      if (entry.result?.type !== "succeeded") {
        this.logger.warn(
          `Batch ${batchId} entry ${entry.custom_id} did not succeed: ${entry.result?.type}`,
        );
        continue;
      }
      const message = entry.result.message;
      const textBlock = (message.content || []).find(
        (block: any) => block.type === "text",
      ) as any;
      const parsed: AiAnalysisResult = JSON.parse(textBlock?.text ?? "{}");
      const usage = message.usage || { input_tokens: 0, output_tokens: 0 };
      results.set(entry.custom_id, {
        result: parsed,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        // Batches API is 50% cheaper than sync.
        costUsd: computeCost(usage) * 0.5,
      });
    }
    return results;
  }
}
