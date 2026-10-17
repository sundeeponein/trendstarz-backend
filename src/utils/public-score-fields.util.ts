/**
 * TrendScore fields attached to public listing rows (Search / Discover cards).
 *
 * - Positive signals (Campaign Ready, TrendStarz Recommended) go to everyone.
 * - The numeric score and the full readiness label go to logged-in viewers
 *   only (guests never see "Not Ready" / low scores on someone's listing).
 * - The suggested price range is never included — it's guidance for the
 *   creator themself (their TrendScore page / pricing form), not a public
 *   price tag. Self/admin get it via GET /api/audit/:userId.
 */
export function publicScoreFields(audit: any, viewerIsAuthenticated: boolean) {
  const readiness = audit?.campaignReadiness ?? null;
  return {
    collaborationScore: viewerIsAuthenticated ? audit?.collaborationScore ?? null : null,
    campaignReadiness: viewerIsAuthenticated || readiness === "Campaign Ready" ? readiness : null,
    trendstarzRecommended: audit?.trendstarzRecommended ?? false,
  };
}
