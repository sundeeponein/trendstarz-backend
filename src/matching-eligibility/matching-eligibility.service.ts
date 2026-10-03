import { Injectable } from "@nestjs/common";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import { EligibilityResult, evaluateEligibility } from "./eligibility";

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
}
