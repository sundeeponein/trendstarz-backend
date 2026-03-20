/**
 * Centralised JWT secret accessor.
 * Throws at startup / first use if JWT_SECRET is not configured,
 * preventing the app from silently falling back to a public key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if ((process.env.NODE_ENV || "development") === "production") {
      throw new Error(
        "JWT_SECRET environment variable is not set. " +
          "The application cannot sign or verify tokens without it.",
      );
    }
    console.warn(
      "JWT_SECRET is not set. Using development fallback secret. " +
        "Set JWT_SECRET in production to keep tokens secure.",
    );
    return "DEV_SECRET_CHANGE_ME";
  }
  return secret;
}
