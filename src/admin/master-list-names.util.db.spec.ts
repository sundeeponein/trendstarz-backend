import { Schema } from "mongoose";
import {
  countNameUsage,
  NameHolderModels,
  renameEverywhere,
} from "./master-list-names.util";
import { inTransaction } from "../utils/mongo-transaction.util";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("master-list renames (real MongoDB)", () => {
  let db: TestDb;
  let models: NameHolderModels;

  beforeAll(async () => {
    db = await startTestDb();
    const loose = () => new Schema({}, { strict: false });
    const names = ["influencer", "brand", "photographer", "campaign", "user", "district", "whatsappCommunity"] as const;
    models = Object.fromEntries(
      names.map((n) => [n, db.conn.model(n, loose(), n)]),
    ) as unknown as NameHolderModels;
    await Promise.all(Object.values(models).map((m) => m.createCollection()));
  });
  afterAll(() => db.stop());
  beforeEach(async () => {
    await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  });

  it("renames an influencer category on profiles and campaigns, but not the brand category of the same name", async () => {
    const [a, both, other] = await models.influencer.insertMany([
      { categories: ["Fashion", "Food"], influencerCategory: "Fashion" },
      { categories: ["Fashion", "Style"] },
      { categories: ["Travel"] },
    ]);
    await models.brand.insertMany([{ categories: ["Fashion"] }]);
    await models.campaign.insertMany([{ categories: ["Fashion"] }]);

    await inTransaction(db.conn, (s) =>
      renameEverywhere(models, "category", "Fashion", "Style", "influencer", s),
    );

    const get = async (d: any) => (await models.influencer.findById(d._id).lean()) as any;
    expect((await get(a)).categories).toEqual(["Style", "Food"]);
    expect((await get(a)).influencerCategory).toBe("Style");
    expect((await get(both)).categories).toEqual(["Style"]); // no duplicate
    expect((await get(other)).categories).toEqual(["Travel"]);
    expect(((await models.brand.findOne().lean()) as any).categories).toEqual(["Fashion"]);
    expect(((await models.campaign.findOne().lean()) as any).categories).toEqual(["Style"]);
  });

  it("renames a state everywhere it is stored and re-derives the WhatsApp community key", async () => {
    await models.influencer.insertMany([{ location: { state: "Telangana" }, communityState: "Telangana" }]);
    await models.campaign.insertMany([{ targetState: "Telangana", venueState: "Telangana" }]);
    await models.district.insertMany([{ name: "Hyderabad", state: "Telangana" }]);
    await models.whatsappCommunity.insertMany([{ state: "Telangana", stateKey: "telangana" }]);

    await inTransaction(db.conn, (s) =>
      renameEverywhere(models, "state", "Telangana", "Telangana State", undefined, s),
    );

    expect((await countNameUsage(models, "state", "Telangana")).total).toBe(0);
    const wa: any = await models.whatsappCommunity.findOne().lean();
    expect(wa).toMatchObject({ state: "Telangana State", stateKey: "telangana_state" });
  });

  it("leaves every holder unchanged when the surrounding transaction fails", async () => {
    await models.influencer.insertMany([{ languages: ["Telugu"] }]);
    await expect(
      inTransaction(db.conn, async (s) => {
        await renameEverywhere(models, "language", "Telugu", "తెలుగు", undefined, s);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(((await models.influencer.findOne().lean()) as any).languages).toEqual(["Telugu"]);
  });
});
