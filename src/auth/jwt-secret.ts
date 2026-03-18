/**
 * Centralised JWT secret accessor.
 * Throws at startup / first use if JWT_SECRET is not configured,
 * preventing the app from silently falling back to a public key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET environment variable is not set. " +
        "The application cannot sign or verify tokens without it.",
    );
  }
  return secret;
}
