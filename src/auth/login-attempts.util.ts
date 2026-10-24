import { HttpException, HttpStatus } from "@nestjs/common";
import type { Collection } from "mongodb";

/** Wrong passwords for one email within the window that lock its login. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/**
 * Per-account login lock (collection login_failures, TTL-cleaned). The per-IP
 * rate limit alone let someone using many addresses keep guessing one
 * account's password. Unknown emails are counted the same way, so the answer
 * never reveals whether an email is registered.
 */
export class LoginAttempts {
  /** Without a database (unit tests with fake models) the lock does nothing. */
  constructor(private readonly collection: Collection<any> | null) {}

  static async init(collection: Collection<any>) {
    await collection.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  }

  /** Throws 429 while this email is locked. */
  async assertNotLocked(email: string, now = new Date()) {
    if (!this.collection) return;
    const row: any = await this.collection.findOne({ _id: email } as any, { projection: { lockedUntil: 1 } });
    const until = row?.lockedUntil ? new Date(row.lockedUntil).getTime() : 0;
    if (until > now.getTime()) {
      const minutes = Math.max(1, Math.ceil((until - now.getTime()) / 60000));
      throw new HttpException(
        `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Records a wrong password; locks the email at LOGIN_MAX_FAILURES within the window. */
  async recordFailure(email: string, now = new Date()) {
    if (!this.collection) return;
    const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
    const row: any = await this.collection.findOneAndUpdate(
      { _id: email } as any,
      [
        {
          $set: {
            failures: {
              $concatArrays: [
                { $filter: { input: { $ifNull: ["$failures", []] }, cond: { $gte: ["$$this", since] } } },
                [now],
              ],
            },
            purgeAt: new Date(now.getTime() + LOGIN_WINDOW_MS + LOGIN_LOCK_MS),
          },
        },
      ] as any,
      { upsert: true, returnDocument: "after" },
    );
    const doc = (row as any)?.value ?? row;
    if ((doc?.failures?.length || 0) >= LOGIN_MAX_FAILURES) {
      await this.collection.updateOne(
        { _id: email } as any,
        { $set: { lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS), failures: [] } },
      );
    }
  }

  /** A successful login (or a password reset) starts the count afresh. */
  async clear(email: string) {
    if (!this.collection) return;
    await this.collection.deleteOne({ _id: email } as any);
  }
}
