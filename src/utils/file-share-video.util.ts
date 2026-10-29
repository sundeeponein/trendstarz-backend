/**
 * "Video (File Share)": a campaign deliverable where the creator sends the
 * video file to the host (Google Drive / Dropbox / … link) instead of posting
 * it on their own social account.
 *
 * Admin only shows/hides the platform (Social Media list, `campaignOnly`).
 * Its formats and aspect ratios live here, like other platforms' content types
 * live in the seed config. Keep in sync with the frontend copy
 * (shared/file-share-video.util.ts).
 */

export const FILE_SHARE_PLATFORM_KEY = "file_share_video";
export const FILE_SHARE_PLATFORM_NAME = "Video (File Share)";
/** Stored as the submission's postPlatform. */
export const FILE_SHARE_POST_PLATFORM = "file_share";

export const FILE_SHARE_RAW = "Raw video";
export const FILE_SHARE_EDITED = "Edited video";
/** Creator's choice when the host offers both formats: priced as the sum, one folder link. */
export const FILE_SHARE_RAW_AND_EDITED = "Raw + Edited video";
export const FILE_SHARE_FORMATS = [FILE_SHARE_RAW, FILE_SHARE_EDITED] as const;

export const FILE_SHARE_ASPECT_RATIOS = ["9:16", "16:9", "both"] as const;
export type FileShareAspectRatio = (typeof FILE_SHARE_ASPECT_RATIOS)[number];

/** Where review copies go when admin hasn't saved one in Settings. */
export const DEFAULT_FILE_SHARE_REVIEW_EMAIL = "sundeep.oneinfo+admin@gmail.com";

const norm = (v: unknown) => String(v ?? "").toLowerCase().trim();

export function isFileSharePlatform(platform: unknown): boolean {
  const p = norm(platform);
  return (
    p === norm(FILE_SHARE_PLATFORM_NAME) ||
    p === FILE_SHARE_PLATFORM_KEY ||
    p === FILE_SHARE_POST_PLATFORM
  );
}

export function isFileShareCombined(contentType: unknown): boolean {
  return norm(contentType) === norm(FILE_SHARE_RAW_AND_EDITED);
}

/** Campaign platforms that are real social accounts (File Share removed). */
export function socialPlatformsOnly(platforms: unknown): string[] {
  return (Array.isArray(platforms) ? platforms : [])
    .map((p) => String(p ?? ""))
    .filter((p) => p && !isFileSharePlatform(p));
}

export function campaignHasFileShare(campaign: any): boolean {
  const names = [
    ...(Array.isArray(campaign?.platforms) ? campaign.platforms : []),
    ...(Array.isArray(campaign?.socialMedia)
      ? campaign.socialMedia.map((sm: any) => sm?.platform)
      : []),
  ];
  return names.some(isFileSharePlatform);
}

/**
 * Price (rupees) of a File Share choice on a campaign row: one format's price,
 * or both formats added up for "Raw + Edited video". 0 when not offered.
 */
export function fileShareOfferRupees(
  row: any,
  contentType: unknown,
): number {
  const enabled = (Array.isArray(row?.contentTypes) ? row.contentTypes : [])
    .filter((ct: any) => ct?.enabled);
  const priceOf = (name: string) => {
    const ct = enabled.find((c: any) => norm(c?.name) === norm(name));
    const rupees = Number(ct?.price || 0);
    return ct && Number.isFinite(rupees) && rupees > 0 ? rupees : 0;
  };
  if (isFileShareCombined(contentType)) {
    const raw = priceOf(FILE_SHARE_RAW);
    const edited = priceOf(FILE_SHARE_EDITED);
    return raw > 0 && edited > 0 ? raw + edited : 0;
  }
  return priceOf(String(contentType ?? ""));
}

/**
 * Checks the File Share row of a campaign's deliverables and returns it
 * cleaned (only Raw/Edited, aspect ratio kept on enabled formats).
 * Throws a plain message the caller turns into a 400.
 */
export function sanitizeFileShareRow(row: any): any {
  const contentTypes = (Array.isArray(row?.contentTypes) ? row.contentTypes : [])
    .filter((ct: any) =>
      FILE_SHARE_FORMATS.some((f) => norm(f) === norm(ct?.name)),
    )
    .map((ct: any) => {
      const name = FILE_SHARE_FORMATS.find((f) => norm(f) === norm(ct?.name))!;
      const enabled = !!ct?.enabled;
      const aspectRatio = String(ct?.aspectRatio ?? "").trim();
      if (enabled && !(FILE_SHARE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
        throw new Error(`Choose an aspect ratio for ${name}.`);
      }
      return {
        ...ct,
        name,
        enabled,
        aspectRatio: enabled ? aspectRatio : undefined,
      };
    });
  return { ...row, platform: FILE_SHARE_PLATFORM_NAME, contentTypes };
}

/** Hosts whose share links we accept for File Share delivery. */
const FILE_SHARE_HOSTS = [
  "drive.google.com",
  "docs.google.com",
  "dropbox.com",
  "onedrive.live.com",
  "1drv.ms",
  "sharepoint.com",
  "wetransfer.com",
  "we.tl",
  "icloud.com",
  "box.com",
];

export function isFileShareLink(url: unknown): boolean {
  let host = "";
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FILE_SHARE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeShareEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : "";
}
