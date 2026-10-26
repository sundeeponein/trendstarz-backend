import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import type { Collection } from "mongodb";
import { hostname } from "os";
import { randomBytes } from "crypto";

/**
 * Scheduled jobs run inside every running copy of the backend. Railway briefly
 * runs the old and new copy together during a deploy, and more replicas mean
 * more copies — so without this, a job (reminders, payout sweep, refund holds…)
 * can run twice at the same time.
 *
 * @SingleInstance() makes each run claim a lease in MongoDB (collection
 * cron_locks) first; a copy that can't claim it skips that run. Put it directly
 * UNDER @Cron(...) so @Cron registers the wrapped method:
 *
 *   @Cron(CronExpression.EVERY_HOUR)
 *   @SingleInstance()
 *   async myJob() { … }
 *
 * The lease is kept for at least MIN_HOLD_MS (so a copy whose clock fires a few
 * seconds later still sees it) and expires after the TTL if a copy crashes.
 * Without a database (unit tests) the job just runs.
 */
const COLLECTION = "cron_locks";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const MIN_HOLD_MS = 50 * 1000; // < the most frequent job's 5-minute interval

const OWNER = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
let locks: Collection<any> | null = null;
const logger = new Logger("SingleInstance");

/** Exposed for tests: point the locks at a database (null = no locking). */
export function setCronLockCollection(collection: Collection<any> | null) {
  locks = collection;
}

/** Claims the lease for `name`; false when another copy holds it. */
export async function claimCronLock(
  name: string,
  ttlMs = DEFAULT_TTL_MS,
  owner = OWNER,
  now = new Date(),
): Promise<boolean> {
  if (!locks) return true;
  try {
    const doc = await locks.findOneAndUpdate(
      { _id: name, lockedUntil: { $lte: now } },
      {
        $set: {
          lockedUntil: new Date(now.getTime() + ttlMs),
          owner,
          startedAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    return !!doc && doc.owner === owner;
  } catch (err: any) {
    // The lease row exists and is still held → the upsert's insert collides.
    if (err?.code === 11000) return false;
    throw err;
  }
}

/** Ends this copy's lease, but keeps it for MIN_HOLD_MS after the start. */
export async function releaseCronLock(
  name: string,
  startedAt: Date,
  owner = OWNER,
  now = new Date(),
) {
  if (!locks) return;
  await locks.updateOne(
    { _id: name, owner },
    {
      $set: {
        lockedUntil: new Date(Math.max(now.getTime(), startedAt.getTime() + MIN_HOLD_MS)),
        finishedAt: now,
      },
    },
  );
}

/**
 * Scheduled jobs run only on the real deploy. A laptop whose .env points at the
 * live database would otherwise run every clean-up, expiry and payout job against
 * live data with local code. CRON_ENABLED=true/false overrides either way.
 */
export function scheduledJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.CRON_ENABLED || "").trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return (
    env.NODE_ENV === "production" ||
    env.NODE_ENV === "test" ||
    !!env.RAILWAY_ENVIRONMENT ||
    !!env.RAILWAY_ENVIRONMENT_NAME ||
    !!env.RAILWAY_ENVIRONMENT_ID
  );
}

let warnedJobsOff = false;

export function SingleInstance(options: { name?: string; ttlMs?: number } = {}): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    const name = options.name || `${target.constructor.name}.${String(propertyKey)}`;
    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      if (!scheduledJobsEnabled()) {
        if (!warnedJobsOff) {
          warnedJobsOff = true;
          logger.warn("Scheduled jobs are OFF here (not the production deploy). Set CRON_ENABLED=true to run them.");
        }
        return undefined;
      }
      const startedAt = new Date();
      let claimed: boolean;
      try {
        claimed = await claimCronLock(name, options.ttlMs ?? DEFAULT_TTL_MS, OWNER, startedAt);
      } catch (err: any) {
        logger.warn(`${name}: could not claim the job lock (${err?.message || err}) — skipping this run`);
        return undefined;
      }
      if (!claimed) return undefined; // another copy is running it
      try {
        return await original.apply(this, args);
      } finally {
        await releaseCronLock(name, startedAt).catch((err: any) =>
          logger.warn(`${name}: could not release the job lock (${err?.message || err})`),
        );
      }
    };
    return descriptor;
  };
}

/** Connects the job locks to the app's database at startup (before any job fires). */
@Injectable()
export class CronLockInitializer implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  onModuleInit() {
    setCronLockCollection(this.connection.db!.collection(COLLECTION));
  }
}
