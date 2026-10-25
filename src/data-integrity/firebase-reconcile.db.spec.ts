import { Types } from "mongoose";
import { reconcileFirebase } from "./firebase-reconcile";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

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
      { _id: new Types.ObjectId(), email: "deleted@x.in", isDeleted: true },
    ]);
    await db.collection("brands").insertOne({ email: "anon@x.in", anonymized: true, firebaseUid: "u-anon" });
    const firebase = [
      { uid: "u-ok", email: "ok@x.in", emailVerified: true },
      { uid: "u-other", email: "someone@x.in" },
      { uid: "u-unv", email: "unverified@x.in", emailVerified: true },
      { uid: "u-del", email: "deleted@x.in" },
      { uid: "u-anon", email: "anon-old@x.in" },
      { uid: "u-orphan", email: "orphan@x.in" },
    ];

    const r = await reconcileFirebase(db, firebase);
    const emails = (rows: any[]) => rows.map((x) => x.email).sort();
    expect(r.accounts).toBe(5);
    expect(emails(r.noFirebaseLogin)).toEqual(["lazy@x.in"]);
    expect(emails(r.linkedToOtherLogin)).toEqual(["moved@x.in", "stale@x.in"]);
    expect(emails(r.deletedButLoginKept)).toEqual(["anon@x.in", "deleted@x.in"]);
    expect(emails(r.loginWithoutAccount)).toEqual(["orphan@x.in"]); // linked logins are reported with their account
    expect(emails(r.verifiedOnlyInFirebase)).toEqual(["unverified@x.in"]);
  });
});
