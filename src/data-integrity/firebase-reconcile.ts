import type { Db } from "mongodb";

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
  /** Firebase login still present for a deleted or anonymized account (personal data kept). */
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
export async function reconcileFirebase(db: Db, firebaseUsers: FirebaseUserLite[]): Promise<FirebaseReconcileResult> {
  const byUid = new Map(firebaseUsers.map((u) => [u.uid, u]));
  const byEmail = new Map(firebaseUsers.filter((u) => u.email).map((u) => [norm(u.email), u]));
  const result: FirebaseReconcileResult = {
    firebaseUsers: firebaseUsers.length,
    accounts: 0,
    noFirebaseLogin: [],
    linkedToOtherLogin: [],
    deletedButLoginKept: [],
    loginWithoutAccount: [],
    verifiedOnlyInFirebase: [],
  };
  const knownEmails = new Set<string>();
  const knownUids = new Set<string>();

  for (const [collection, role] of ROLES) {
    const rows = await db
      .collection(collection)
      .find({}, { projection: { email: 1, firebaseUid: 1, isDeleted: 1, anonymized: 1, status: 1, isEmailVerified: 1 } })
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
        if (linked || sameEmail) result.deletedButLoginKept.push(row("account deleted, Firebase login still exists"));
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
