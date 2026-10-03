import { Injectable } from "@nestjs/common";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import {
  CampaignEligibilityList,
  buildCampaignEligibilityList,
  parseCampaignEligibilityQuery,
  toEligibilityRow,
} from "./campaign-eligibility";
import {
  EligibilityResult,
  NOT_EVALUATED,
  evaluateEligibility,
} from "./eligibility";

/**
 * Stage 3B-2 — loads the Stage 3B-1 normalized inputs (read-only) and runs
 * the pure deterministic evaluator. Informational only: it never invites,
 * notifies, writes, ranks or changes any existing campaign behaviour.
 */
@Injectable()
export class MatchingEligibilityService {
  constructor(private readonly inputs: MatchingInputsService) {}

  async evaluate(
    campaignId: string,
    creatorType: string,
    creatorId: string,
  ): Promise<EligibilityResult> {
    const [campaign, creator] = await Promise.all([
      this.inputs.forCampaign(campaignId),
      this.inputs.forCreator(creatorType, creatorId),
    ]);
    return evaluateEligibility(campaign, creator);
  }

  /**
   * Stage 3B-3 — the same evaluation for every non-deleted creator of the
   * campaign's recipient type, grouped PASS / UNKNOWN / FAIL. Read-only; no
   * scores or ranking.
   */
  async evaluateCampaign(
    campaignId: string,
    rawQuery: Record<string, unknown> = {},
  ): Promise<CampaignEligibilityList> {
    const query = parseCampaignEligibilityQuery(rawQuery);
    const { input: campaign, title } =
      await this.inputs.forCampaignWithTitle(campaignId);
    const creatorType =
      campaign.recipientRole === "photographer" ? "Photographer" : "Influencer";
    const creators = await this.inputs.forAllCreators(creatorType);
    const rows = creators.map(({ input, display }) =>
      toEligibilityRow(evaluateEligibility(campaign, input), display),
    );
    return buildCampaignEligibilityList(
      campaign,
      title,
      creatorType,
      rows,
      query,
      NOT_EVALUATED.map((n) => ({ ...n })),
    );
  }
}
