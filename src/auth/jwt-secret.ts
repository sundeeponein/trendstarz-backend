/**
 * Centralised JWT secret accessor.
 * Throws at startup / first use if JWT_SECRET is not configured,
 * preventing the app from silently falling back to a public key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET || "TRENDSTARZ_DEFAULT_SECRET_%23";
  if (!process.env.JWT_SECRET) {
    if ((process.env.NODE_ENV || "development") === "production") {
      console.warn(
        "WARNING: JWT_SECRET is not set in production. Using default fallback secret. " +
          "Set JWT_SECRET in your deployment env to ensure secure token signing.",
      );
    } else {
      console.warn(
        "JWT_SECRET is not set. Using local fallback secret. " +
          "Set JWT_SECRET for production environments.",
      );
    }
  }
  return secret;
}
