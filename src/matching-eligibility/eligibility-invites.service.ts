import { BadRequestException, Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { CampaignInvitesService } from "../campaigns/campaign-invites.service";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import { REQUIREMENT_KEYS } from "./campaign-eligibility";
import { evaluateEligibility } from "./eligibility";

export const MAX_INVITES_PER_REQUEST = 50;

export interface EligibilityInviteOutcome {
  requested: number;
  invited: Array<{ creatorId: string; inviteId: string }>;
  skipped: Array<{ creatorId: string; reason: string }>;
}

/**
 * Stage 3B-4 — admin sends invites to creators picked from the campaign
 * eligibility list. Each invite goes through the existing invite flow
 * (CampaignInvitesService.create) as the campaign OWNER, so the owner's plan
 * limits, deadline and slot caps, recipient caps and notifications all apply
 * exactly as when the host invites. Adds two guards on top: the creator must
 * be PASS right now (re-evaluated, never trusted from the client), and must
 * not already hold an invite for this campaign.
 *
 * Nothing automatic: only the creators the admin selected, one request.
 */
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

    const { input: campaign, ownerId } =
      await this.inputs.forCampaignWithTitle(campaignId);
    if (campaign.status.toLowerCase() !== "active")
      throw new BadRequestException(
        "Invites can only be sent for live (approved) campaigns.",
      );
    if (!ownerId) throw new BadRequestException("Campaign has no owner.");

    const creatorType =
      campaign.recipientRole === "photographer" ? "Photographer" : "Influencer";
    const alreadyInvited = await this.invites.invitedRecipientIds(
      campaignId,
      ids,
    );

    const outcome: EligibilityInviteOutcome = {
      requested: ids.length,
      invited: [],
      skipped: [],
    };
    // Sequential on purpose: each create() counts existing invites for the
    // owner's plan limits, so parallel calls could overshoot them.
    for (const creatorId of ids) {
      const skip = (reason: string) =>
        outcome.skipped.push({ creatorId, reason });
      if (!Types.ObjectId.isValid(creatorId)) {
        skip("Invalid creator id.");
        continue;
      }
      if (alreadyInvited.has(creatorId)) {
        skip("Already invited to this campaign.");
        continue;
      }
      try {
        const creator = await this.inputs.forCreator(creatorType, creatorId);
        const result = evaluateEligibility(campaign, creator);
        if (result.overall !== "PASS") {
          const blocking = REQUIREMENT_KEYS.map(
            (k) => result.requirements[k],
          ).find((r) => r.status !== "PASS");
          skip(`Not eligible: ${blocking?.reason ?? result.overall}`);
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
          Array.isArray(message)
            ? message.join(", ")
            : String(message || "Failed to send invite."),
        );
      }
    }
    return outcome;
  }
}
