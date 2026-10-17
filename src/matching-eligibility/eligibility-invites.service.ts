import { BadRequestException, Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { CampaignInvitesService } from "../campaigns/campaign-invites.service";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import { REQUIREMENT_KEYS, campaignInviteWindow } from "./campaign-eligibility";
import { evaluateEligibility } from "./eligibility";

export const MAX_INVITES_PER_REQUEST = 50;

/**
 * Per-creator result. `needs_review` codes mean the admin's selection is out of
 * date (eligibility or invite state changed since the list was loaded).
 */
export type EligibilityInviteSkipCode =
  | "invalid_id"
  | "unavailable"
  | "already_invited"
  | "not_eligible"
  | "eligibility_unknown"
  | "invite_rejected";

export interface EligibilityInviteOutcome {
  requested: number;
  invited: Array<{ creatorId: string; inviteId: string }>;
  skipped: Array<{
    creatorId: string;
    code: EligibilityInviteSkipCode;
    reason: string;
  }>;
}

@Injectable()
export class EligibilityInvitesService {
  constructor(
    private readonly inputs: MatchingInputsService,
    private readonly invites: CampaignInvitesService,
  ) {}

  async invite(
    campaignId: string,
    creatorIds: unknown,
    adminId: string,
  ): Promise<EligibilityInviteOutcome> {
    const ids = [
      ...new Set(
        (Array.isArray(creatorIds) ? creatorIds : [])
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter(Boolean),
      ),
    ];
    if (!ids.length)
      throw new BadRequestException("Select at least one creator.");
    if (ids.length > MAX_INVITES_PER_REQUEST)
      throw new BadRequestException(
        `At most ${MAX_INVITES_PER_REQUEST} creators per request.`,
      );
    if (!adminId) throw new BadRequestException("Admin not identified.");

    // Everything below is re-derived on the server; the browser only supplies
    // which creator ids the admin ticked.
    const { input: campaign, ownerId } =
      await this.inputs.forCampaignWithTitle(campaignId);
    const window = campaignInviteWindow(campaign);
    if (!window.open) throw new BadRequestException(window.reason);
    if (!ownerId) throw new BadRequestException("Campaign has no owner.");

    const creatorType =
      campaign.recipientRole === "photographer" ? "Photographer" : "Influencer";
    // Two batch reads for the whole selection (no per-creator profile queries).
    const [alreadyInvited, creators] = await Promise.all([
      this.invites.invitedRecipientIds(campaignId, ids),
      this.inputs.forCreatorsByIds(creatorType, ids),
    ]);

    const outcome: EligibilityInviteOutcome = {
      requested: ids.length,
      invited: [],
      skipped: [],
    };
    // Sequential on purpose: each create() counts existing invites for the
    // owner's plan limits, so parallel calls could overshoot them.
    for (const creatorId of ids) {
      const skip = (code: EligibilityInviteSkipCode, reason: string) =>
        outcome.skipped.push({ creatorId, code, reason });
      if (!Types.ObjectId.isValid(creatorId)) {
        skip("invalid_id", "Invalid creator id.");
        continue;
      }
      if (alreadyInvited.has(creatorId)) {
        skip("already_invited", "Already invited to this campaign.");
        continue;
      }
      const creator = creators.get(creatorId);
      if (!creator || creator.eligibility.isDeleted) {
        skip("unavailable", "Creator unavailable (not found or deleted).");
        continue;
      }
      const result = evaluateEligibility(campaign, creator);
      if (result.overall !== "PASS") {
        const blocking = REQUIREMENT_KEYS.map(
          (k) => result.requirements[k],
        ).find((r) => r.status === result.overall);
        skip(
          result.overall === "FAIL" ? "not_eligible" : "eligibility_unknown",
          `${result.overall === "FAIL" ? "No longer eligible" : "Eligibility unknown"}: ${blocking?.reason ?? result.overall}`,
        );
        continue;
      }
      try {
        // Last-moment duplicate check: the host (or another admin) may have
        // invited this creator since the batch check above.
        if (
          (await this.invites.invitedRecipientIds(campaignId, [creatorId])).size
        ) {
          skip("already_invited", "Already invited to this campaign.");
          continue;
        }
        const invite: any = await this.invites.create(
          ownerId,
          {
            campaignId,
            influencerId: creatorId,
            recipientRole:
              creatorType === "Photographer" ? "photographer" : "influencer",
          },
          { invitedByAdminId: adminId },
        );
        outcome.invited.push({
          creatorId,
          inviteId: String(invite?._id ?? ""),
        });
      } catch (err: any) {
        const message = err?.response?.message ?? err?.message;
        skip(
          "invite_rejected",
          Array.isArray(message)
            ? message.join(", ")
            : String(message || "Failed to send invite."),
        );
      }
    }
    return outcome;
  }
}
