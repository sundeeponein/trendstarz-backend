import type { ClientSession, Connection } from "mongoose";

/**
 * Runs `work` in one MongoDB transaction: every write that passes the session
 * commits together or not at all (Atlas is a replica set, so this is
 * supported). Used where one business action spans several documents — e.g.
 * a payout updates the transaction row AND the invite.
 *
 * Rules for `work`:
 *  - Only database reads/writes that pass `session`. No emails, pushes,
 *    notifications or platform events — the driver may re-run `work` on a
 *    transient error, so side effects go after this resolves.
 *  - Re-read what it needs inside (don't rely on documents loaded before).
 *  - Throwing (e.g. BadRequestException) aborts the transaction and rethrows.
 *
 * With no connection (unit tests build services without one) `work` runs
 * directly with session undefined — the same writes, just not atomic.
 */
export async function inTransaction<T>(
  connection: Connection | null | undefined,
  work: (session?: ClientSession) => Promise<T>,
): Promise<T> {
  if (!connection || typeof connection.startSession !== "function") {
    return work(undefined);
  }
  const session = await connection.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Adds the session to a query/update options object when there is one. */
export function withSession<O extends Record<string, unknown>>(
  options: O,
  session?: ClientSession,
): O & { session?: ClientSession } {
  return session ? { ...options, session } : options;
}

/** Model.create for one document; inside a session Mongoose needs the array form. */
export async function createOne(
  model: any,
  doc: Record<string, unknown>,
  session?: ClientSession,
): Promise<any> {
  if (!session) return model.create(doc);
  const [created] = await model.create([doc], { session });
  return created;
}
