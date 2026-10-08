import { ForbiddenException, Injectable } from "@nestjs/common";
import { normalizeCampaignMatchInput } from "../matching-inputs/matching-inputs";
import { CampaignInvitesService } from "../campaigns/campaign-invites.service";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import {
  CampaignEligibilityList,
  buildCampaignEligibilityList,
  parseCampaignEligibilityQuery,
  toEligibilityRow,
} from "./campaign-eligibility";
import {
  HostEligibilityView,
  buildHostEligibilityView,
} from "./host-eligibility";
import {
  EligibilityResult,
  NOT_EVALUATED,
  evaluateEligibility,
} from "./eligibility";
import { rankEligibleCreators } from "./match-ranking";

/** Who may preview requirements: anyone who can create a campaign/collaboration. */
const PREVIEW_ROLES = new Set([
  "brand",
  "photographer",
  "influencer",
  "admin",
  "subadmin",
]);
/** The campaign fields the matching inputs read — nothing else is taken from the body. */
const PREVIEW_FIELDS = [
  "inviteRecipientRole",
  "campaignMode",
  "campaignType",
  "platforms",
  "categories",
  "targetTiers",
  "socialMedia",
  "minInfluencerTier",
  "targetState",
  "targetDistrict",
  "targetCities",
  "venueState",
  "venueDistrict",
  "languages",
] as const;

/**
 * Stage 3B-2 — loads the Stage 3B-1 normalized inputs (read-only) and runs
 * the pure deterministic evaluator. Informational only: it never invites,
 * notifies, writes or changes any existing campaign behaviour.
 */
@Injectable()
export class MatchingEligibilityService {
  constructor(
    private readonly inputs: MatchingInputsService,
    private readonly invites: CampaignInvitesService,
  ) {}

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
   * campaign's recipient type, grouped PASS / UNKNOWN / FAIL. Read-only.
   * Stage 3C-1: PASS rows also carry an informational deterministic rank
   * (no score, no weights) — invited/invitable and row order are unchanged.
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
    const [creators, invited] = await Promise.all([
      this.inputs.forAllCreators(creatorType),
      this.invites.invitedRecipientIds(campaignId),
    ]);
    // Stage 3C-1: one clock per request — the invite window and every
    // creator's activity bucket are judged against the same instant.
    const asOf = new Date();
    const evaluated = creators.map(({ input, display }) => ({
      creator: input,
      display,
      result: evaluateEligibility(campaign, input),
    }));
    const ranked = new Map(
      rankEligibleCreators(campaign, evaluated, asOf).map((r) => [
        r.creatorId,
        r,
      ]),
    );
    const rows = evaluated.map(({ creator, display, result }) =>
      toEligibilityRow(
        result,
        display,
        invited.has(creator.creatorId),
        ranked.get(creator.creatorId) ?? null,
      ),
    );
    return buildCampaignEligibilityList(
      campaign,
      title,
      creatorType,
      rows,
      query,
      NOT_EVALUATED.map((n) => ({ ...n })),
      asOf,
    );
  }

  /**
   * Requirements preview for a campaign that is still being written (the
   * campaign form's invite step, before anything is saved): the same host
   * labels as forHost, computed from the form's unsaved requirements. Only the
   * fields that affect matching are read; the owner type comes from the
   * requester's role, never the body. Nothing is stored.
   */
  async previewForHost(
    draft: Record<string, unknown>,
    requester: { role?: string },
  ): Promise<HostEligibilityView> {
    const role = String(requester?.role || "").toLowerCase();
    if (!PREVIEW_ROLES.has(role))
      throw new ForbiddenException(
        "Not allowed to preview creator eligibility",
      );
    const body: Record<string, unknown> =
      draft && typeof draft === "object" ? draft : {};
    const picked: Record<string, unknown> = { _id: "", status: "draft" };
    for (const key of PREVIEW_FIELDS) if (key in body) picked[key] = body[key];
    picked.ownerType = role === "photographer" ? "photographer" : "brand";
    const campaign = normalizeCampaignMatchInput(picked);
    if (campaign.recipientRole === "photographer")
      return buildHostEligibilityView(campaign, []);
    const creators = await this.inputs.forAllCreators("Influencer");
    return buildHostEligibilityView(
      campaign,
      creators.map(({ input }) => evaluateEligibility(campaign, input)),
    );
  }

  /**
   * Stage 3B-4 — host view for the campaign owner (or an admin): which
   * approved creators meet the campaign's requirements, as labels only.
   */
  async forHost(
    campaignId: string,
    requester: { userId?: string; role?: string },
  ): Promise<HostEligibilityView> {
    const { input: campaign, ownerId } =
      await this.inputs.forCampaignWithTitle(campaignId);
    const role = String(requester?.role || "").toLowerCase();
    const isAdmin = role === "admin" || role === "subadmin";
    if (
      !isAdmin &&
      !(await this.invites.isCampaignOwner(
        ownerId,
        String(requester?.userId || ""),
      ))
    )
      throw new ForbiddenException("Not your campaign");
    if (campaign.recipientRole === "photographer")
      return buildHostEligibilityView(campaign, []);
    const creators = await this.inputs.forAllCreators("Influencer");
    return buildHostEligibilityView(
      campaign,
      creators.map(({ input }) => evaluateEligibility(campaign, input)),
    );
  }
}
