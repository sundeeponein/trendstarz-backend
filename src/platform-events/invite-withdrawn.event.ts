import { RecordPlatformEventInput } from "./platform-events.service";
import {
  InviteWithdrawnReason,
  PlatformEventActorRole,
} from "./platform-event-types";

/**
 * invite_withdrawn — shared by every path that moves an invite to "withdrawn"
 * (CampaignInvitesService and the admin cancel-participation override), so the
 * event shape can't drift between them. Withdrawn is terminal, hence one per invite.
 *
 * The free-text withdrawnReason (owner-typed, or admin notes) is deliberately not
 * copied — metadata.reason is the classified cause.
 */
export function inviteWithdrawnEvent(
  invite: any,
  reason: InviteWithdrawnReason,
  actor: { userId?: unknown; userRole: PlatformEventActorRole },
  previousStatus: string,
  at: Date,
): RecordPlatformEventInput {
  return {
    eventType: "invite_withdrawn",
    timestamp: at,
    userId: actor.userId,
    userRole: actor.userRole,
    brandId: invite?.brandId,
    campaignId: invite?.campaignId,
    influencerId: invite?.influencerId,
    inviteId: invite?._id,
    recipientRole:
      String(invite?.recipientRole || "").toLowerCase() === "photographer"
        ? "photographer"
        : "influencer",
    platform: invite?.selectedPlatform || null,
    metadata: {
      reason,
      // Whether the creator had already accepted (i.e. a lost collaboration, not an unanswered invite).
      previousStatus: String(previousStatus || "").toLowerCase() || null,
    },
    dedupeKey: `invite_withdrawn:${String(invite?._id)}`,
  };
}
