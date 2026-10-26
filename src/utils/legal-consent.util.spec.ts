import { consentOnSignup, LEGAL_VERSIONS } from "./legal-consent.util";
import { SERVER_OWNED_PROFILE_FIELDS } from "./server-owned-profile-fields.util";

describe("consent at sign-up", () => {
  it("refuses a sign-up without an explicit yes", () => {
    for (const body of [{}, { acceptedTerms: false }, { acceptedTerms: "true" }, null]) {
      expect(() => consentOnSignup(body)).toThrow(/agree to the Terms of Service and Privacy Policy/);
    }
  });

  it("records when and which versions were accepted", () => {
    const now = new Date("2026-10-26T10:00:00Z");
    expect(consentOnSignup({ acceptedTerms: true }, now)).toEqual({
      termsAcceptedAt: now,
      termsVersion: LEGAL_VERSIONS.terms,
      privacyVersion: LEGAL_VERSIONS.privacy,
    });
  });

  it("can't be changed later by a profile save", () => {
    for (const f of ["termsAcceptedAt", "termsVersion", "privacyVersion", "sessionsRevokedAt"]) {
      expect(SERVER_OWNED_PROFILE_FIELDS).toContain(f);
    }
  });
});
