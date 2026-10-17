/**
 * Real MongoDB for *.db.spec.ts tests: a one-node replica set in memory, so
 * transactions, unique/partial indexes, schema casting and validators behave
 * exactly as on Atlas. (Named *-spec.ts: excluded from the build, not a test.)
 * The first run downloads a mongod binary into ~/.cache/mongodb-binaries.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Connection } from "mongoose";

export interface TestDb {
  conn: Connection;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const conn = await mongoose.createConnection(rs.getUri()).asPromise();
  return {
    conn,
    stop: async () => {
      await conn.close();
      await rs.stop();
    },
  };
}

/** Generous: the first run may download mongod. */
export const DB_TEST_TIMEOUT_MS = 120_000;
