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

describe("one-time consent prompt for older accounts", () => {
  const { consentNeeded, consentOnPrompt } = jest.requireActual("./legal-consent.util");

  it("asks accounts made before the checkbox, and accounts on older versions", () => {
    expect(consentNeeded({})).toBe(true);
    expect(consentNeeded({ termsAcceptedAt: null })).toBe(true);
    expect(
      consentNeeded({ termsAcceptedAt: new Date(), termsVersion: "2026-01-01", privacyVersion: LEGAL_VERSIONS.privacy }),
    ).toBe(true);
  });

  it("doesn't ask anyone who accepted the current versions", () => {
    expect(
      consentNeeded({
        termsAcceptedAt: new Date(),
        termsVersion: LEGAL_VERSIONS.terms,
        privacyVersion: LEGAL_VERSIONS.privacy,
      }),
    ).toBe(false);
  });

  it("needs the same explicit yes as sign-up", () => {
    for (const body of [{}, { acceptedTerms: "true" }, null]) {
      expect(() => consentOnPrompt(body)).toThrow(/agree to the Terms of Service and Privacy Policy/);
    }
    const now = new Date("2026-11-18T10:00:00Z");
    expect(consentOnPrompt({ acceptedTerms: true }, now)).toEqual({
      termsAcceptedAt: now,
      termsVersion: LEGAL_VERSIONS.terms,
      privacyVersion: LEGAL_VERSIONS.privacy,
    });
  });
});
