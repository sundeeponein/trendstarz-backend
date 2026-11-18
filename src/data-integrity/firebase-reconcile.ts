import type { Db } from "mongodb";
import { ADMIN_SOFT_DELETE_RETENTION_DAYS, SELF_DELETION_GRACE_PERIOD_DAYS } from "../users/users.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The nightly cleanup runs once a day; give it this long before calling a login stuck. */
const CLEANUP_SLACK_DAYS = 2;

/** The parts of a Firebase user this comparison reads. */
export interface FirebaseUserLite {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
}

export interface FirebaseReconcileRow {
  email: string;
  role: string;
  accountId: string;
  /** What is wrong, in plain words. */
  problem: string;
}

export interface FirebaseReconcileResult {
  firebaseUsers: number;
  accounts: number;
  /** Live account with no Firebase login yet — information only: forgot-password creates it on demand. */
  noFirebaseLogin: FirebaseReconcileRow[];
  /** Account linked to a Firebase user that has a different email (or no longer exists). */
  linkedToOtherLogin: FirebaseReconcileRow[];
  /**
   * Deleted but still restorable (admin delete: 90 days; self-delete: grace period).
   * The login is kept on purpose so a restore works; the nightly cleanup removes it
   * when it anonymizes the account. Information only. removeOn = that day.
   */
  deletedAwaitingCleanup: Array<FirebaseReconcileRow & { removeOn: string }>;
  /**
   * Login still present although it should be gone: account anonymized, past its
   * removal day, or deleted without a date (the cleanup never picks those up).
   */
  deletedButLoginKept: FirebaseReconcileRow[];
  /** Firebase login whose email matches no account at all. */
  loginWithoutAccount: FirebaseReconcileRow[];
  /** Firebase says the email is verified, the account says not (the daily Firebase email sync should fix it). */
  verifiedOnlyInFirebase: FirebaseReconcileRow[];
}

const ROLES: Array<[collection: string, role: string]> = [
  ["influencers", "influencer"],
  ["brands", "brand"],
  ["photographers", "photographer"],
  ["users", "admin"],
];

const norm = (v: unknown) => String(v || "").trim().toLowerCase();

/**
 * Firebase Authentication vs TrendStarZ accounts, read-only. Password resets
 * and Firebase sign-in tokens go through Firebase while everything else uses
 * the account in MongoDB, so the two must describe the same people.
 */
export async function reconcileFirebase(
  db: Db,
  firebaseUsers: FirebaseUserLite[],
  now: Date = new Date(),
): Promise<FirebaseReconcileResult> {
  const byUid = new Map(firebaseUsers.map((u) => [u.uid, u]));
  const byEmail = new Map(firebaseUsers.filter((u) => u.email).map((u) => [norm(u.email), u]));
  const result: FirebaseReconcileResult = {
    firebaseUsers: firebaseUsers.length,
    accounts: 0,
    noFirebaseLogin: [],
    linkedToOtherLogin: [],
    deletedAwaitingCleanup: [],
    deletedButLoginKept: [],
    loginWithoutAccount: [],
    verifiedOnlyInFirebase: [],
  };
  const knownEmails = new Set<string>();
  const knownUids = new Set<string>();

  for (const [collection, role] of ROLES) {
    const rows = await db
      .collection(collection)
      .find({}, { projection: { email: 1, firebaseUid: 1, isDeleted: 1, anonymized: 1, status: 1, isEmailVerified: 1, deletedAt: 1 } })
      .toArray();
    for (const a of rows as any[]) {
      const email = norm(a.email);
      if (email) knownEmails.add(email);
      if (a.firebaseUid) knownUids.add(String(a.firebaseUid));
      const row = (problem: string): FirebaseReconcileRow => ({ email, role, accountId: String(a._id), problem });
      const gone = a.isDeleted === true || a.anonymized === true || a.status === "deleted";
      const linked = a.firebaseUid ? byUid.get(String(a.firebaseUid)) : undefined;
      const sameEmail = email ? byEmail.get(email) : undefined;
      if (gone) {
        if (!(linked || sameEmail)) continue;
        if (a.anonymized === true) {
          result.deletedButLoginKept.push(row("account anonymized, Firebase login still exists"));
          continue;
        }
        // Same timing as the nightly cleanup: admin deletes wait 90 days, self-deletes the grace period.
        const keepDays = a.status === "deletion_pending" ? SELF_DELETION_GRACE_PERIOD_DAYS : ADMIN_SOFT_DELETE_RETENTION_DAYS;
        const deletedAt = a.deletedAt ? new Date(a.deletedAt) : null;
        if (!deletedAt || Number.isNaN(deletedAt.getTime())) {
          result.deletedButLoginKept.push(row("deleted without a date — the cleanup never removes this login"));
          continue;
        }
        const removeOn = new Date(deletedAt.getTime() + keepDays * DAY_MS);
        if (now.getTime() > removeOn.getTime() + CLEANUP_SLACK_DAYS * DAY_MS) {
          result.deletedButLoginKept.push(
            row("past its removal day, login still exists (open work or money, or the cleanup failed)"),
          );
          continue;
        }
        result.deletedAwaitingCleanup.push({
          ...row(a.status === "deletion_pending" ? "deletion requested — can still cancel" : "deleted — restorable"),
          removeOn: removeOn.toISOString(),
        });
        continue;
      }
      result.accounts += 1;
      if (a.firebaseUid && !linked) {
        result.linkedToOtherLogin.push(row(sameEmail ? "linked Firebase user no longer exists (another login has this email)" : "linked Firebase user no longer exists"));
      } else if (linked && norm(linked.email) !== email) {
        result.linkedToOtherLogin.push(row(`linked Firebase login uses ${norm(linked.email) || "no email"}`));
      } else if (!linked && !sameEmail && email) {
        result.noFirebaseLogin.push(row("no Firebase login for this email"));
      }
      const fb = linked || sameEmail;
      if (fb?.emailVerified === true && a.isEmailVerified !== true) {
        result.verifiedOnlyInFirebase.push(row("verified in Firebase, not in TrendStarZ"));
      }
    }
  }

  for (const u of firebaseUsers) {
    const email = norm(u.email);
    if (email && !knownEmails.has(email) && !knownUids.has(u.uid)) {
      result.loginWithoutAccount.push({ email, role: "", accountId: "", problem: "Firebase login with no TrendStarZ account" });
    }
  }
  return result;
}
