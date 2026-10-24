const CREATOR_DASHBOARDS = ["/influencer-dashboard", "/photographer-dashboard"];

/**
 * Where a creator notification should open. Many notifications only link to
 * the dashboard; send them to the part that's about them instead:
 * money → the Earnings/Payments section, invites/offers → the invite list,
 * campaign work (post, review, dispute, closed…) → the Campaigns page.
 * Links that already say more (?invite=…, other pages) are kept as they are.
 */
export function creatorNotificationUrl(url: unknown, title: unknown, body?: unknown): string {
  const link = String(url ?? "");
  if (!CREATOR_DASHBOARDS.includes(link)) return link;
  const text = `${String(title ?? "")} ${String(body ?? "")}`.toLowerCase();
  if (/payout|payment|paid|refund|₹|earning|credit/.test(text)) return `${link}?section=payments`;
  if (/invite|offer|counter|collaboration request/.test(text)) return `${link}?section=invites`;
  if (/post|submission|submitted|approved|review|dispute|campaign|deadline|participation|shipping|product|visit/.test(text)) {
    return "/campaigns?tab=campaigns";
  }
  return link;
}
