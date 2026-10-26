import { Schema } from "mongoose";
import { AdminUserTableController } from "./admin-user-table.controller";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("admin dashboard counts come from the database (real MongoDB)", () => {
  let db: TestDb;
  let ctrl: any;
  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    ctrl = Object.assign(Object.create(AdminUserTableController.prototype), {
      influencerModel: loose("Influencer", "influencers"),
      brandModel: loose("Brand", "brands"),
      photographerModel: loose("Photographer", "photographers"),
    });
  });
  afterAll(() => db.stop());

  it("counts every account — not just the first page — and leaves deleted ones out", async () => {
    const future = new Date(Date.now() + 86400000);
    const past = new Date(Date.now() - 86400000);
    await db.conn.collection("influencers").insertMany([
      ...Array.from({ length: 150 }, () => ({ status: "accepted" })),
      ...Array.from({ length: 5 }, () => ({ status: "pending" })),
      { status: "accepted", isPremium: true, premiumEnd: future },
      { status: "accepted", isPremium: true, premiumEnd: past }, // lapsed: not Premium
      { status: "deleted", isDeleted: true },
      { status: "deletion_pending", isDeleted: true },
    ]);
    await db.conn.collection("brands").insertOne({ status: "pending" });
    const r = await ctrl.userCounts();
    expect(r.influencers).toEqual({ total: 157, active: 152, pending: 5, premium: 1 });
    expect(r.brands).toEqual({ total: 1, active: 0, pending: 1, premium: 0 });
    expect(r.photographers).toEqual({ total: 0, active: 0, pending: 0, premium: 0 });
  });
});
