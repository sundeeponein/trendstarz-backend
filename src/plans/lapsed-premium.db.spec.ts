import { Schema, Types } from "mongoose";
import { PlansService } from "./plans.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("lapsed Premium flags (real MongoDB)", () => {
  let db: TestDb;
  let service: PlansService;

  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false }), col);
    const [plan, sub, inf, brand, photo] = [
      loose("Plan", "plans"),
      loose("Subscription", "subscriptions"),
      loose("Influencer", "influencers"),
      loose("Brand", "brands"),
      loose("Photographer", "photographers"),
    ];
    service = new (PlansService as any)(plan, sub, inf, brand, photo);
  });
  afterAll(() => db.stop());

  it("clears isPremium only where Premium really ended", async () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const past = new Date("2026-10-18T00:00:00Z");
    const future = new Date("2027-01-01T00:00:00Z");
    const lapsed = new Types.ObjectId();
    const current = new Types.ObjectId();
    const renewedSubOnly = new Types.ObjectId(); // profile end not yet moved, but a paid sub runs
    const lapsedBrand = new Types.ObjectId();
    await db.conn.collection("influencers").insertMany([
      { _id: lapsed, isPremium: true, premiumEnd: past },
      { _id: current, isPremium: true, premiumEnd: future },
      { _id: renewedSubOnly, isPremium: true, premiumEnd: past },
    ]);
    await db.conn.collection("brands").insertOne({ _id: lapsedBrand, isPremium: true, premiumEnd: past });
    await db.conn.collection("subscriptions").insertMany([
      { userId: renewedSubOnly, status: "active", endDate: future },
      { userId: lapsed, status: "expired", endDate: past },
    ]);

    expect(await service.clearLapsedPremiumFlags(now)).toBe(2);

    const flag = async (col: string, id: Types.ObjectId) => ((await db.conn.collection(col).findOne({ _id: id })) as any).isPremium;
    expect(await flag("influencers", lapsed)).toBe(false);
    expect(await flag("brands", lapsedBrand)).toBe(false);
    expect(await flag("influencers", current)).toBe(true);
    expect(await flag("influencers", renewedSubOnly)).toBe(true);
    expect(((await db.conn.collection("influencers").findOne({ _id: lapsed })) as any).premiumEnd).toEqual(past); // history kept
  });
});
