/**
 * Profile fields that never leave the server in another user's view (lists, search,
 * invite pickers). Contact fields (email, phone, website) are deliberately not here:
 * list code reads them to decide whether this viewer may contact the person, and
 * blanks them otherwise. Use as `.select(PRIVATE_PROFILE_EXCLUSION)`.
 */
export const PRIVATE_PROFILE_FIELDS = [
  "payout",
  "firebaseUid",
  "previousVerifiedEmail",
  "previousVerifiedMobile",
  "verificationDocuments",
  "verificationAdminNotes",
  "verificationAuditLog",
  "verificationDisclaimerAccepted",
  "adminTags",
  "commissionOverride",
  "commissionBadge",
  "earlyAccessGrantedAt",
  "mobileCallbackRequestedAt",
  "declineReason",
  "signupAttribution",
  "socialMediaEditLog",
  "adminSocialNotifications",
  "mustChangePassword",
  "tempPasswordExpiresAt",
  "tempPasswordIssuedAt",
  "tempPasswordIssuedBy",
  "passwordResetRequestedAt",
  "statusBeforeDeletion",
  "restoredAt",
  "dateOfBirth",
  "gender",
  "emailVerificationSentAt",
  "emailVerificationWhatsappReminderSentAt",
  "mobileVerifiedBy",
  "reviewedBy",
  "premiumSource",
] as const;

export const PRIVATE_PROFILE_EXCLUSION = privateProfileExclusion();

/** The exclusion, minus fields this list needs server-side and strips from its output. */
export function privateProfileExclusion(keep: string[] = []): string {
  return PRIVATE_PROFILE_FIELDS.filter((f) => !keep.includes(f))
    .map((f) => `-${f}`)
    .join(" ");
}
