import { derivePlatformKey } from "../utils/social-account.util";

/** Invite statuses the creator can still answer (accept / decline / counter-offer). */
const OPEN_INVITE_STATUSES = ["pending", "invited"];

export interface TierChangeSinceInvite {
  platform: string;
  tier: string;
  changedAt: Date;
}

/**
 * Accounts whose tier an admin or the automatic YouTube correction changed AFTER
 * this invite was sent — shown on OPEN invites only ("Your tier changed to Micro
 * after this invite was sent"), so the creator knows they can counter-offer.
 * Agreed or paid collaborations are never touched: money is never changed here.
 * Limited to the campaign's platforms when it lists any.
 */
export function tierChangesSinceInvite(
  socialMedia: unknown,
  invite: { status?: string; createdAt?: unknown; campaignId?: any },
): TierChangeSinceInvite[] {
  if (!OPEN_INVITE_STATUSES.includes(invite?.status ?? "")) return [];
  const sentAt = invite?.createdAt
    ? new Date(invite.createdAt as string).getTime()
    : NaN;
  if (!Number.isFinite(sentAt)) return [];
  const campaignPlatforms: string[] = Array.isArray(
    invite?.campaignId?.platforms,
  )
    ? invite.campaignId.platforms.map((p: unknown) => derivePlatformKey(p))
    : [];
  const changes: TierChangeSinceInvite[] = [];
  for (const sm of Array.isArray(socialMedia) ? socialMedia : []) {
    const changedAt = sm?.tierChangedAt ? new Date(sm.tierChangedAt) : null;
    if (!changedAt || changedAt.getTime() <= sentAt) continue;
    const key = derivePlatformKey(sm?.platformKey || sm?.platform);
    if (campaignPlatforms.length && !campaignPlatforms.includes(key)) continue;
    changes.push({
      platform: String(sm?.platform ?? ""),
      tier: String(sm?.tier ?? ""),
      changedAt,
    });
  }
  return changes;
}
