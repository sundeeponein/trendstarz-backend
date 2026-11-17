import { ConflictException, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import type { Collection } from "mongodb";
import { randomBytes } from "crypto";

/**
 * Limits are checked by counting and then creating ("3 of 3 slots used?").
 * Two requests arriving together both count 2 and both create, so the limit
 * is passed. withRequestLocks() runs the count-and-create for the same key
 * (one host's slots, one campaign's accepted places, one creator's monthly
 * invites) one request at a time. The second request waits a moment, then
 * counts again and gets the normal limit message.
 *
 * Locks live in MongoDB (collection request_locks), so they hold across every
 * running copy of the backend. A lock left by a crashed request expires after
 * ttlMs. Without a database (unit tests), fn just runs.
 */
const COLLECTION = "request_locks";
const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_WAIT_MS = 15 * 1000;
const RETRY_MS = 100;

let locks: Collection<any> | null = null;

/** Exposed for tests: point the locks at a database (null = no locking). */
export function setRequestLockCollection(collection: Collection<any> | null) {
  locks = collection;
}

async function tryClaim(key: string, owner: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  try {
    // Free, or left behind by a crashed request: take it.
    const doc = await locks!.findOneAndUpdate(
      { _id: key, lockedUntil: { $lte: now } },
      { $set: { owner, lockedUntil: new Date(now.getTime() + ttlMs), at: now } },
      { upsert: true, returnDocument: "after" },
    );
    return !!doc && doc.owner === owner;
  } catch (err: any) {
    // Held by another request → the upsert's insert collides.
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function release(keys: string[], owner: string) {
  await locks!.deleteMany({ _id: { $in: keys }, owner }).catch(() => undefined);
}

export async function withRequestLocks<T>(
  keys: string[],
  fn: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  if (!locks) return fn();
  // Sorted, so two requests needing the same keys always take them in the same order.
  const wanted = [...new Set(keys.filter(Boolean))].sort();
  if (!wanted.length) return fn();
  const owner = randomBytes(8).toString("hex");
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const giveUpAt = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const held: string[] = [];
  try {
    for (const key of wanted) {
      while (!(await tryClaim(key, owner, ttlMs))) {
        if (Date.now() >= giveUpAt) {
          throw new ConflictException(
            "Another request for this is still being saved. Please try again in a moment.",
          );
        }
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
      held.push(key);
    }
    return await fn();
  } finally {
    if (held.length) await release(held, owner);
  }
}

/** Connects the request locks to the app's database at startup. */
@Injectable()
export class RequestLockInitializer implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  onModuleInit() {
    setRequestLockCollection(this.connection.db!.collection(COLLECTION));
  }
}

/** One host's monthly campaign slots (campaign submit/resubmit). */
export const campaignSlotLockKey = (ownerId: string) => `campaign-slots:${ownerId}`;
/** One campaign's invite count and accepted places (send, accept, apply). */
export const campaignInvitesLockKey = (campaignId: string) => `campaign-invites:${campaignId}`;
/** One creator's monthly invite slots (invites from any host). */
export const creatorSlotLockKey = (creatorId: string) => `creator-slots:${creatorId}`;
/** One host's invites-per-month count. */
export const hostInvitesLockKey = (ownerId: string) => `host-invites:${ownerId}`;
