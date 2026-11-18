import { BadRequestException } from "@nestjs/common";

/**
 * Versions of the legal pages people agree to at sign-up — the "Last Updated"
 * date shown on /terms-and-conditions and /privacy-policy. Change these when
 * those pages change, so each account shows exactly what it accepted.
 */
export const LEGAL_VERSIONS = { terms: "2026-11-03", privacy: "2026-11-03" } as const;

/**
 * Sign-up must carry an explicit "I agree" (DPDP: consent is a clear action),
 * and the account keeps when and which versions were accepted.
 */
export function consentOnSignup(data: any, now = new Date()) {
  if (data?.acceptedTerms !== true) {
    throw new BadRequestException("Please agree to the Terms of Service and Privacy Policy to create an account.");
  }
  return {
    termsAcceptedAt: now,
    termsVersion: LEGAL_VERSIONS.terms,
    privacyVersion: LEGAL_VERSIONS.privacy,
  };
}

/**
 * Accounts made before the sign-up checkbox (or before the current Terms /
 * Privacy versions) are asked once, at their next visit, to agree.
 */
export function consentNeeded(profile: any): boolean {
  if (!profile?.termsAcceptedAt) return true;
  return (
    String(profile?.termsVersion || "") !== LEGAL_VERSIONS.terms ||
    String(profile?.privacyVersion || "") !== LEGAL_VERSIONS.privacy
  );
}

/** The "I agree" from that one-time prompt: same explicit yes as sign-up. */
export function consentOnPrompt(data: any, now = new Date()) {
  if (data?.acceptedTerms !== true) {
    throw new BadRequestException("Please agree to the Terms of Service and Privacy Policy to continue.");
  }
  return {
    termsAcceptedAt: now,
    termsVersion: LEGAL_VERSIONS.terms,
    privacyVersion: LEGAL_VERSIONS.privacy,
  };
}
