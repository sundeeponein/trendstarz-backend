import { randomBytes } from "node:crypto";

const developmentJwtSecret = randomBytes(32).toString("hex");

/**
 * Centralised JWT secret accessor.
 * Throws in production if JWT_SECRET is not configured,
 * preventing the app from silently falling back to a known key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if ((process.env.NODE_ENV || "development") === "production") {
      throw new Error(
        "FATAL: JWT_SECRET environment variable is not set. " +
          "The application cannot start without a secure JWT secret in production.",
      );
    }
    console.warn(
      "[AUTH] JWT_SECRET is not set. Using a temporary development-only fallback secret. " +
        "Never run without JWT_SECRET in production.",
    );
    return developmentJwtSecret;
  }
  if (secret.length < 32) {
    console.warn(
      "[AUTH] JWT_SECRET is set but is shorter than 32 characters. Use a longer secret for better security.",
    );
  }
  return secret;
}
