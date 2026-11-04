/**
 * Open campaigns judge a creator's state, district and niches as they were
 * when the campaign went live, so editing the profile after seeing a post
 * ("Travel campaign in Telangana") doesn't open that campaign. Tier is exempt:
 * creators outgrow their registered tier, and the host checks the profile
 * before accepting. Decided 2026-11-04.
 */
import { campaignNicheRefusal, matchesCampaignNiche } from "./campaign-niche.util";

export type EligibilityField = "state" | "district" | "categories";

export interface EligibilityChange {
  field: EligibilityField;
  from: string | string[];
  to: string | string[];
  changedAt: Date;
}

export interface EligibilityProfile {
  state: string;
  district: string;
  categories: string[];
}

/** Kept per creator — enough to cover any campaign still open. */
export const ELIGIBILITY_HISTORY_LIMIT = 50;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean);
}

function sameList(a: string[], b: string[]): boolean {
  const key = (l: string[]) => l.map((v) => v.toLowerCase()).sort().join("|");
  return key(a) === key(b);
}

export function currentEligibilityProfile(creator: any): EligibilityProfile {
  return {
    state: text(creator?.location?.state),
    district: text(creator?.location?.district),
    categories: list(creator?.categories),
  };
}

/** What a profile save changed among state, district and niches (case-insensitive). */
export function eligibilityChanges(
  before: EligibilityProfile,
  after: EligibilityProfile,
  changedAt: Date = new Date(),
): EligibilityChange[] {
  const changes: EligibilityChange[] = [];
  for (const field of ["state", "district"] as const) {
    if (before[field].toLowerCase() !== after[field].toLowerCase()) {
      changes.push({ field, from: before[field], to: after[field], changedAt });
    }
  }
  if (!sameList(before.categories, after.categories)) {
    changes.push({ field: "categories", from: before.categories, to: after.categories, changedAt });
  }
  return changes;
}

/** The creator's state, district and niches at `at`, undoing later changes newest first. */
export function eligibilityProfileAsOf(creator: any, at: unknown): EligibilityProfile {
  const profile = currentEligibilityProfile(creator);
  const atTime = at ? new Date(at as string).getTime() : NaN;
  if (!Number.isFinite(atTime)) return profile;
  const later = (Array.isArray(creator?.eligibilityHistory) ? creator.eligibilityHistory : [])
    .filter((c: any) => new Date(c?.changedAt).getTime() > atTime)
    .sort((a: any, b: any) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());
  for (const change of later) {
    if (change.field === "categories") profile.categories = list(change.from);
    else if (change.field === "state" || change.field === "district") profile[change.field as "state" | "district"] = text(change.from);
  }
  return profile;
}

/** When the campaign went live (older campaigns have no liveAt). */
export function campaignLiveAt(campaign: any): Date | null {
  const raw = campaign?.liveAt || campaign?.moderatedAt || campaign?.createdAt;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Why this profile can't apply to the campaign by state, district or niche, or
 * null. A blank state/district passes, as it always has.
 */
export function locationNicheRefusal(campaign: any, profile: EligibilityProfile): string | null {
  const differs = (mine: string, target: unknown) =>
    !!mine && !!text(target) && mine.toLowerCase() !== text(target).toLowerCase();
  if (differs(profile.state, campaign?.targetState)) {
    return `This campaign is limited to influencers from ${campaign.targetState}.`;
  }
  if (differs(profile.district, campaign?.targetDistrict)) {
    return `This campaign is limited to influencers from ${campaign.targetDistrict}, ${campaign.targetState}.`;
  }
  if (!matchesCampaignNiche(campaign, profile.categories)) {
    return campaignNicheRefusal(campaign, profile.categories);
  }
  return null;
}

/** Apply-time refusal: explains when only a change made after go-live would have matched. */
export function openCampaignProfileRefusal(creator: any, campaign: any): string | null {
  const reason = locationNicheRefusal(campaign, eligibilityProfileAsOf(creator, campaignLiveAt(campaign)));
  if (!reason) return null;
  if (!locationNicheRefusal(campaign, currentEligibilityProfile(creator))) {
    return "You updated your state, district or niche after this campaign went live, so it doesn't count for this campaign. It counts for campaigns that go live after your update.";
  }
  return reason;
}
