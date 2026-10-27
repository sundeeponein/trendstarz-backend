import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { ProfileViewer } from "./profile-eligibility.util";

/**
 * The logged-in viewer of a public profile page, or null for a guest. Only a
 * real login counts: tokens made for one purpose (email verification, Meta
 * connect) and unsigned or expired tokens are treated as a guest.
 */
export function profileViewerFromRequest(req: any): ProfileViewer | null {
  try {
    const token = String(req?.headers?.authorization || "").split(" ")[1];
    if (!token) return null;
    const decoded: any = jwt.verify(token, getJwtSecret());
    if (decoded?.purpose) return null;
    const userId = String(decoded?.userId || "").trim();
    const role = String(decoded?.role || "").trim().toLowerCase();
    return userId && role ? { userId, role } : null;
  } catch {
    return null;
  }
}
