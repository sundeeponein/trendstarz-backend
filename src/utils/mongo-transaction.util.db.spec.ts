import { Schema } from "mongoose";
import { createOne, inTransaction, withSession } from "./mongo-transaction.util";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("inTransaction (real MongoDB)", () => {
  let db: TestDb;
  let Tx: any;
  let Invite: any;
  let Ledger: any;

  beforeAll(async () => {
    db = await startTestDb();
    Tx = db.conn.model("Tx", new Schema({ payoutStatus: String }));
    Invite = db.conn.model("Inv", new Schema({ status: String }));
    Ledger = db.conn.model("Ledger", new Schema({ amount: Number }));
    // Collections must exist before first use inside a transaction.
    await Promise.all([Tx, Invite, Ledger].map((m) => m.createCollection()));
  });
  afterAll(() => db.stop());
  beforeEach(async () => {
    await Promise.all([Tx, Invite, Ledger].map((m) => m.deleteMany({})));
  });

  const claim = (txId: unknown, session?: any) =>
    Tx.findOneAndUpdate(
      { _id: txId, payoutStatus: "pending" },
      { $set: { payoutStatus: "paid" } },
      withSession({ new: true }, session),
    ).lean();

  it("rolls back every write when the work throws part-way", async () => {
    const tx = await Tx.create({ payoutStatus: "pending" });
    await expect(
      inTransaction(db.conn, async (session) => {
        await claim(tx._id, session);
        await createOne(Ledger, { amount: 500 }, session);
        throw new Error("crash between writes");
      }),
    ).rejects.toThrow("crash between writes");
    expect((await Tx.findById(tx._id).lean()).payoutStatus).toBe("pending");
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it("commits all documents together and returns the work's result", async () => {
    const tx = await Tx.create({ payoutStatus: "pending" });
    const inv = await Invite.create({ status: "completed" });
    const claimed = await inTransaction(db.conn, async (session) => {
      const row = await claim(tx._id, session);
      await Invite.updateOne(
        { _id: inv._id },
        { $set: { status: "approved" } },
        withSession({}, session),
      );
      return row;
    });
    expect(claimed.payoutStatus).toBe("paid");
    expect((await Invite.findById(inv._id).lean()).status).toBe("approved");
  });

  it("lets exactly one of several parallel claims win (no double payout)", async () => {
    const tx = await Tx.create({ payoutStatus: "pending" });
    const attempt = () =>
      inTransaction(db.conn, async (session) => {
        const row = await claim(tx._id, session);
        if (row) await createOne(Ledger, { amount: 1 }, session);
        return !!row;
      });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await Ledger.countDocuments()).toBe(1);
  });

  it("runs the work directly when there is no connection (unit-test mode)", async () => {
    await expect(
      inTransaction(undefined, async (session) => session === undefined),
    ).resolves.toBe(true);
  });
});
