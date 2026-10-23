import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";

export interface UploadCaller {
  userId: string;
  role: string;
}

/** Staging folders used before an account (or campaign) exists. Open to anyone. */
const PENDING_FOLDER =
  /^(influencers|photographers|brands|campaigns)\/_pending\/(profile|gallery|verification|logo|products|images)$/;
const OWN_FOLDER = /^(influencers|photographers|brands)\/([a-f0-9]{24})\/(profile|gallery|verification|logo|products)$/;
const CAMPAIGN_IMAGES_FOLDER = /^campaigns\/[a-f0-9]{24}\/images$/;
const ANY_FOLDER = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;

const ROLE_ROOT: Record<string, string> = {
  influencer: "influencers",
  photographer: "photographers",
  brand: "brands",
};

/**
 * The caller of a public upload endpoint, if a valid login token was sent.
 * Uploads stay open without login (registration), so a missing or bad token
 * just means "anonymous" — it never fails the upload.
 */
export function uploadCallerFrom(authHeader: unknown): UploadCaller | null {
  const raw = typeof authHeader === "string" ? authHeader.split(" ")[1] : "";
  if (!raw) return null;
  try {
    const decoded: any = jwt.verify(raw, getJwtSecret());
    if (decoded?.purpose || !decoded?.userId || !decoded?.role) return null;
    return { userId: String(decoded.userId), role: String(decoded.role).toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Which Cloudinary folder an upload may go to. The requested folder used to be
 * trusted as-is, so anyone (no login needed) could drop files into another
 * account's or campaign's folder. Now:
 *  - anyone: the `_pending` staging folders used during registration;
 *  - logged in: also their own account folders, and campaign image folders;
 *  - admins: any well-formed folder (they fix other users' photos).
 * Anything else falls back to `fallback`, so older app versions keep working.
 */
export function resolveUploadFolder(
  requested: unknown,
  caller: UploadCaller | null,
  fallback: string,
): string {
  const folder = typeof requested === "string" ? requested.trim() : "";
  if (!folder || !ANY_FOLDER.test(folder)) return fallback;
  if (PENDING_FOLDER.test(folder)) return folder;
  if (!caller) return fallback;
  if (caller.role === "admin" || caller.role === "subadmin") return folder;
  const own = OWN_FOLDER.exec(folder);
  if (own && own[1] === ROLE_ROOT[caller.role] && own[2] === caller.userId) return folder;
  if (CAMPAIGN_IMAGES_FOLDER.test(folder)) return folder;
  return fallback;
}
