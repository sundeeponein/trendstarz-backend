import { Types } from "mongoose";
import { PriceChangesService, PRICE_CHANGES } from "./price-changes.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("price changes (real MongoDB)", () => {
  let db: TestDb;
  let service: PriceChangesService;
  const notifications = { createForUser: jest.fn().mockResolvedValue(null) };
  const push = { sendToUser: jest.fn().mockResolvedValue(null) };

  beforeAll(async () => {
    db = await startTestDb();
    service = new PriceChangesService(db.conn as any, notifications as any, push as any);
  });
  afterAll(() => db.stop());

  const reel = (oldPrice: number, newPrice: number) => ({
    source: "social" as const,
    socialAccountId: "sa-1",
    platform: "Instagram",
    rateName: "Reel",
    oldPrice,
    newPrice,
  });

  it("keeps one waiting price per rate; re-saving the same raise adds nothing", async () => {
    const id = new Types.ObjectId();
    await service.record(String(id), "influencer", [], [reel(500, 2000)]);
    await service.record(String(id), "influencer", [], [reel(500, 2000)]);
    await service.record(String(id), "influencer", [], [reel(500, 3000)]);
    const rows = await db.conn.collection(PRICE_CHANGES).find({ userId: String(id) }).toArray();
    expect(rows.map((r) => [r.status, r.newPrice]).sort()).toEqual([
      ["pending", 3000],
      ["replaced", 2000],
    ]);
    // An ordinary change to the same rate replaces the waiting one.
    await service.record(String(id), "influencer", [reel(500, 700)], []);
    const pending = await service.pendingForUser(String(id));
    expect(pending).toEqual([]);
  });

  it("approve sets the new price only while the profile still shows the old one", async () => {
    const id = new Types.ObjectId();
    await db.conn.collection("influencers").insertOne({
      _id: id,
      socialMedia: [
        { socialAccountId: "sa-1", platform: "Instagram", contentTypes: [{ name: "Reel", price: 500 }, { name: "Story", price: 500 }] },
      ],
    });
    await service.record(String(id), "influencer", [], [reel(500, 2000)]);
    const [waiting] = await service.pendingForUser(String(id));
    await service.approve(waiting._id, "admin-1");
    const doc: any = await db.conn.collection("influencers").findOne({ _id: id });
    expect(doc.socialMedia[0].contentTypes.map((c: any) => c.price)).toEqual([2000, 500]);
    expect(doc.socialMedia[0].contentTypes[0].priceConfirmedAt).toBeInstanceOf(Date);
    await expect(service.approve(waiting._id, "admin-1")).rejects.toThrow(/already handled/);

    // Profile price moved since the raise: nothing applied, marked replaced.
    await service.record(String(id), "influencer", [], [reel(500, 5000)]);
    const [stale] = await service.pendingForUser(String(id));
    await expect(service.approve(stale._id, "admin-1")).rejects.toThrow(/changed or was removed/);
    const after: any = await db.conn.collection("influencers").findOne({ _id: id });
    expect(after.socialMedia[0].contentTypes[0].price).toBe(2000);
    expect((await db.conn.collection(PRICE_CHANGES).findOne({ _id: new Types.ObjectId(stale._id) }))?.status).toBe("replaced");
  });

  it("approves photographer pricing rows and rejects leave the price alone", async () => {
    const id = new Types.ObjectId();
    await db.conn.collection("photographers").insertOne({
      _id: id,
      pricing: [{ name: "Per Shoot", price: 3000, enabled: true }],
    });
    const shoot = (newPrice: number) => ({
      source: "pricing" as const, socialAccountId: "", platform: "", rateName: "Per Shoot", oldPrice: 3000, newPrice,
    });
    await service.record(String(id), "photographer", [], [shoot(9000)]);
    let [waiting] = await service.pendingForUser(String(id));
    await service.reject(waiting._id, "admin-1", "too high for tier");
    let doc: any = await db.conn.collection("photographers").findOne({ _id: id });
    expect(doc.pricing[0].price).toBe(3000);

    await service.record(String(id), "photographer", [], [shoot(6000)]);
    [waiting] = await service.pendingForUser(String(id));
    await service.approve(waiting._id, "admin-1");
    doc = await db.conn.collection("photographers").findOne({ _id: id });
    expect(doc.pricing[0].price).toBe(6000);

    const signals = await service.signalsFor([String(id)]);
    expect(signals.get(String(id))?.pricePendingCount).toBe(0);
    expect(signals.get(String(id))?.lastPriceChangeAt).toBeInstanceOf(Date);
  });
});
