/**
 * Pure helpers for the admin "Email offer to free creators" action
 * (offer-email.service.ts): who counts as a recipient, the per-offer send key,
 * the default benefit lines and the signed "Stop offer emails" token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type OfferRole = "influencer" | "brand" | "photographer";

/** Free, live account with an address — same "live" and "premium" rules as admin user counts. */
export function offerAudienceFilter(now: Date = new Date()): Record<string, any> {
  return {
    isDeleted: { $ne: true },
    anonymized: { $ne: true },
    status: { $in: ["pending", "accepted"] },
    offerEmailsOptOut: { $ne: true },
    email: { $type: "string", $regex: /@/ },
    $nor: [{ isPremium: true, $or: [{ premiumEnd: null }, { premiumEnd: { $gte: now } }] }],
  };
}

/** One send per person per offer per email kind; a new offer (new end date / title) gets a new key. */
export function offerSendKey(plan: any, kind: string): string {
  const started = plan?.founderOfferStartedAt ? new Date(plan.founderOfferStartedAt).toISOString() : "none";
  const ends = plan?.founderOfferEndsAt ? new Date(plan.founderOfferEndsAt).toISOString() : "none";
  return `${String(plan?._id)}:${started}:${ends}:${kind}`;
}

export function formatRupees(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/** "10 November, 11:59 PM IST" for the 23:59 IST end of the offer day. */
export function offerEndsLabel(endsAt: Date): string {
  const day = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Kolkata",
  }).format(endsAt);
  return `${day}, 11:59 PM IST`;
}

const limitText = (v: number) => (v < 0 ? "Unlimited" : String(v));

/**
 * Benefit lines that are true today: Premium features the Free plan lacks,
 * limits Premium raises, and a lower creator fee when one is set. The admin can
 * edit these before sending.
 */
export function defaultOfferBenefits(
  proPlan: any,
  freePlan: any,
  settings: any,
  role: OfferRole,
): string[] {
  const lines: string[] = [];

  if (settings?.platformFeeEnabled && role !== "brand") {
    const field = role === "photographer" ? "photographerRecipientFeePercent" : "influencerRecipientFeePercent";
    const free = Number(settings?.[field] ?? 0);
    const premiumRaw = settings?.[`${field}Premium`];
    const premium = premiumRaw === null || premiumRaw === undefined || premiumRaw === "" ? null : Number(premiumRaw);
    if (premium !== null && Number.isFinite(premium) && premium < free) {
      lines.push(`Lower platform fee on paid collaborations (${premium}% instead of ${free}%)`);
    }
  }

  const freeLimits = new Map<string, number>(
    (freePlan?.limits || []).map((l: any) => [String(l.key), Number(l.value)]),
  );
  for (const l of proPlan?.limits || []) {
    const pro = Number(l?.value);
    const free = freeLimits.get(String(l?.key));
    if (!Number.isFinite(pro) || free === undefined || !Number.isFinite(free)) continue;
    const better = (pro < 0 && free >= 0) || (pro >= 0 && free >= 0 && pro > free);
    if (better) lines.push(`${l.label}: ${limitText(pro)} (Free: ${limitText(free)})`);
  }

  const freeFeatures = new Map<string, boolean>(
    (freePlan?.features || []).map((f: any) => [String(f.key), !!f.value]),
  );
  for (const f of proPlan?.features || []) {
    if (f?.value && !freeFeatures.get(String(f.key))) lines.push(String(f.label));
  }

  return lines;
}

/** Up to 8 plain-text lines, each ≤ 140 chars. */
export function cleanBenefits(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, 8);
}

// ── "Stop offer emails" link ────────────────────────────────────────────────

function sign(role: string, id: string, secret: string): string {
  return createHmac("sha256", secret).update(`offer-unsub:${role}:${id}`).digest("base64url");
}

export function offerUnsubscribeToken(role: OfferRole, id: string, secret: string): string {
  return `${role}.${id}.${sign(role, id, secret)}`;
}

export function verifyOfferUnsubscribeToken(
  token: unknown,
  secret: string,
): { role: OfferRole; id: string } | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [role, id, sig] = parts;
  if (!["influencer", "brand", "photographer"].includes(role)) return null;
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const expected = Buffer.from(sign(role, id, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { role: role as OfferRole, id };
}
