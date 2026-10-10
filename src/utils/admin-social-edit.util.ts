import { derivePlatformKey, newSocialAccountId } from "./social-account.util";

/**
 * Applies a handle/tier edit to a loaded creator profile document (not saved):
 * sets the value, keeps one latest edit-log entry per account, and queues the
 * creator's "your social account was updated" notice. Shared by the admin user
 * pop-up edit and the automatic YouTube tier correction, so both look the same
 * to the creator. The caller saves and runs verification reconcile().
 */
export function recordSocialEdit(
  user: any,
  index: number,
  body: {
    handle?: string;
    tier?: string;
    changedBy?: string;
    changedByName?: string;
  },
): void {
  const sm = user.socialMedia[index];
  // Entries edited before the backfill get their identity here (same as a creator save would).
  if (!sm.socialAccountId) sm.socialAccountId = newSocialAccountId();
  if (!sm.platformKey) sm.platformKey = derivePlatformKey(sm.platform);
  const socialAccountId = String(sm.socialAccountId);

  const logEntry = {
    platformIdx: index,
    socialAccountId,
    platform: sm.platform || "",
    oldHandle: sm.handle || "",
    newHandle:
      body.handle !== undefined ? String(body.handle).trim() : sm.handle || "",
    oldTier: sm.tier || "",
    newTier: body.tier !== undefined ? String(body.tier).trim() : sm.tier || "",
    changedBy: body.changedBy || "",
    changedByName: body.changedByName || "",
    changedAt: new Date(),
  };

  if (body.handle !== undefined) sm.handle = String(body.handle).trim();
  if (body.tier !== undefined) {
    const nextTier = String(body.tier).trim();
    // Rates set before this moment are flagged "check this rate" for the creator.
    if (nextTier !== String(sm.tier ?? "")) sm.tierChangedAt = new Date();
    sm.tier = nextTier;
  }

  // One latest log/notice per account: match by id, or by position for pre-backfill rows.
  const sameAccount = (e: any) =>
    e?.socialAccountId
      ? e.socialAccountId === socialAccountId
      : e?.platformIdx === index;

  if (!Array.isArray(user.socialMediaEditLog)) user.socialMediaEditLog = [];
  const existingIdx = user.socialMediaEditLog.findIndex(sameAccount);
  if (existingIdx >= 0) {
    user.socialMediaEditLog[existingIdx] = logEntry;
  } else {
    user.socialMediaEditLog.push(logEntry);
  }

  if (!Array.isArray(user.adminSocialNotifications))
    user.adminSocialNotifications = [];
  const notifEntry = {
    platformIdx: index,
    socialAccountId,
    platform: logEntry.platform,
    oldHandle: logEntry.oldHandle,
    newHandle: logEntry.newHandle,
    oldTier: logEntry.oldTier,
    newTier: logEntry.newTier,
    changedByName: logEntry.changedByName,
    changedAt: logEntry.changedAt,
    seen: false,
  };
  const existingNotifIdx = user.adminSocialNotifications.findIndex(sameAccount);
  if (existingNotifIdx >= 0) {
    user.adminSocialNotifications[existingNotifIdx] = notifEntry;
  } else {
    user.adminSocialNotifications.push(notifEntry);
  }
}
