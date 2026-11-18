import { Types } from "mongoose";
import { reconcileFirebase } from "./firebase-reconcile";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T06:00:00Z");

describe("Firebase logins vs TrendStarZ accounts (real MongoDB)", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await startTestDb();
  });
  afterAll(() => tdb.stop());

  it("sorts every mismatch into its own list", async () => {
    const db: any = tdb.conn.db;
    await db.collection("influencers").insertMany([
      { _id: new Types.ObjectId(), email: "ok@x.in", firebaseUid: "u-ok", isEmailVerified: true },
      { _id: new Types.ObjectId(), email: "Lazy@X.in" }, // no Firebase login yet (info)
      { _id: new Types.ObjectId(), email: "moved@x.in", firebaseUid: "u-other" }, // linked login has another email
      { _id: new Types.ObjectId(), email: "stale@x.in", firebaseUid: "u-gone" }, // linked login deleted
      { _id: new Types.ObjectId(), email: "unverified@x.in", firebaseUid: "u-unv", isEmailVerified: false },
      { _id: new Types.ObjectId(), email: "deleted@x.in", isDeleted: true }, // no date: never cleaned up
      { email: "recent@x.in", isDeleted: true, status: "deleted", deletedAt: new Date(NOW - 10 * DAY) },
      { email: "pending@x.in", isDeleted: true, status: "deletion_pending", deletedAt: new Date(NOW - 1 * DAY) },
      { email: "overdue@x.in", isDeleted: true, status: "deleted", deletedAt: new Date(NOW - 95 * DAY) },
    ]);
    await db.collection("brands").insertOne({ email: "anon@x.in", anonymized: true, firebaseUid: "u-anon" });
    const firebase = [
      { uid: "u-ok", email: "ok@x.in", emailVerified: true },
      { uid: "u-other", email: "someone@x.in" },
      { uid: "u-unv", email: "unverified@x.in", emailVerified: true },
      { uid: "u-del", email: "deleted@x.in" },
      { uid: "u-anon", email: "anon-old@x.in" },
      { uid: "u-orphan", email: "orphan@x.in" },
      { uid: "u-recent", email: "recent@x.in" },
      { uid: "u-pending", email: "pending@x.in" },
      { uid: "u-overdue", email: "overdue@x.in" },
    ];

    const r = await reconcileFirebase(db, firebase, new Date(NOW));
    const emails = (rows: any[]) => rows.map((x) => x.email).sort();
    expect(r.accounts).toBe(5);
    expect(emails(r.noFirebaseLogin)).toEqual(["lazy@x.in"]);
    expect(emails(r.linkedToOtherLogin)).toEqual(["moved@x.in", "stale@x.in"]);
    expect(emails(r.deletedButLoginKept)).toEqual(["anon@x.in", "deleted@x.in", "overdue@x.in"]);
    // Still restorable: login kept on purpose, with the day the cleanup removes it.
    const waiting = Object.fromEntries(r.deletedAwaitingCleanup.map((x) => [x.email, x.removeOn.slice(0, 10)]));
    expect(waiting).toEqual({
      "recent@x.in": new Date(NOW + 80 * DAY).toISOString().slice(0, 10),
      "pending@x.in": new Date(NOW + 29 * DAY).toISOString().slice(0, 10),
    });
    expect(emails(r.loginWithoutAccount)).toEqual(["orphan@x.in"]); // linked logins are reported with their account
    expect(emails(r.verifiedOnlyInFirebase)).toEqual(["unverified@x.in"]);
  });
});
