/**
 * Open-campaign niche rule (decided 2026-11-04): when the host picks niches,
 * only creators with at least one of them can see the campaign and apply.
 * No niches picked = open to every niche. Creators with no niche on their
 * profile don't match a niche-limited campaign.
 *
 * Photographer-recipient campaigns are not limited by niche.
 */

const key = (value: unknown) => String(value || "").trim().toLowerCase();

/** The campaign's niches ("" entries dropped), as the host spelled them. */
export function campaignNiches(campaign: any): string[] {
  if (String(campaign?.inviteRecipientRole || "influencer") === "photographer") return [];
  return (Array.isArray(campaign?.categories) ? campaign.categories : [])
    .map((c: unknown) => String(c || "").trim())
    .filter(Boolean);
}

export function matchesCampaignNiche(campaign: any, creatorCategories: unknown): boolean {
  const niches = campaignNiches(campaign).map(key);
  if (!niches.length) return true;
  const mine = new Set((Array.isArray(creatorCategories) ? creatorCategories : []).map(key).filter(Boolean));
  return niches.some((n) => mine.has(n));
}

export function campaignNicheRefusal(campaign: any, creatorCategories: unknown): string {
  const hasNiche = (Array.isArray(creatorCategories) ? creatorCategories : []).some((c) => key(c));
  const list = campaignNiches(campaign).join(", ");
  return hasNiche
    ? `This campaign is only for ${list} creators.`
    : `This campaign is only for ${list} creators. Add your niche to your profile to apply.`;
}
