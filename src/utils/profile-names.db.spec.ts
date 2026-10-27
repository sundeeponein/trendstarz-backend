import { Model } from "mongoose";
import { checkedProfileName } from "./profile-names.util";
import { BrandSchema, InfluencerSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** Profile links (/influencer/<username>, /brand/<name>) must keep pointing at one account. */
describe("renaming on profile save (real MongoDB)", () => {
  let db: TestDb;
  let brands: Model<any>;
  let influencers: Model<any>;
  let mine: string;
  let other: string;
  let asha: string;
  let legacy: string;

  beforeAll(async () => {
    db = await startTestDb();
    brands = db.conn.model("Brand", BrandSchema, "brands");
    influencers = db.conn.model("Influencer", InfluencerSchema, "influencers");
    const b = await db.conn.collection("brands").insertMany([
      { email: "mine@x.in", brandName: "My Shop", brandUsername: "my-shop" },
      { email: "real@x.in", brandName: "Carol's Cosmetics", brandUsername: "carols-cosmetics" },
      { email: "v@x.in", brandName: "Vaarahi fashions", brandUsername: "vaarahi" },
    ]);
    mine = String(b.insertedIds[0]);
    other = String(b.insertedIds[1]);
    const i = await db.conn.collection("influencers").insertMany([
      { email: "a@x.in", username: "asha" },
      { email: "r@x.in", username: "ravi" },
      { email: "old@x.in", username: "Old.Name" }, // legacy form, kept while unchanged
    ]);
    asha = String(i.insertedIds[0]);
    legacy = String(i.insertedIds[2]);
  });
  afterAll(() => db.stop());

  const fails = (p: Promise<unknown>) => p.then(() => "saved", (e) => e.message);

  it("a brand can't take another brand's name or link, in any spelling", async () => {
    for (const name of ["vaarahi fashions", "VAARAHI  FASHIONS", "Vaarahi-Fashions", " vaarahi fashions "]) {
      expect(await fails(checkedProfileName(brands, mine, "brandName", name))).toBe("Another brand already uses this name.");
    }
    // Reads as another brand's link name: /brand/carols-cosmetics would open this one.
    expect(await fails(checkedProfileName(brands, mine, "brandName", "Carols Cosmetics"))).toBe("Another brand already uses this name.");
    expect(await fails(checkedProfileName(brands, mine, "brandUsername", "Carols-Cosmetics"))).toBe("That brand username is already taken.");
    expect(await fails(checkedProfileName(brands, mine, "brandUsername", "vaarahi-fashions"))).toBe("That brand username is already taken.");
    expect(await fails(checkedProfileName(brands, mine, "brandName", "  "))).toBe("Brand name is required.");
  });

  it("a brand keeps or tidies its own name, and may pick a free one", async () => {
    expect(await checkedProfileName(brands, mine, "brandName", "my  shop")).toBe("my shop");
    expect(await checkedProfileName(brands, mine, "brandName", "My Shop Store")).toBe("My Shop Store");
    expect(await checkedProfileName(brands, mine, "brandUsername", "My-Shop")).toBe("my-shop");
    expect(await checkedProfileName(brands, mine, "brandUsername", "myshop_store")).toBe("myshop_store");
    expect(await checkedProfileName(brands, other, "brandName", "Carol's Cosmetics")).toBe("Carol's Cosmetics");
  });

  it("usernames: link-safe form, not taken, deleted-… reserved", async () => {
    expect(await checkedProfileName(influencers, asha, "username", "Asha")).toBe("asha");
    expect(await checkedProfileName(influencers, asha, "username", " Asha_Rao ")).toBe("asha_rao");
    for (const bad of ["asha rao", "asha/rao", "", "a.b", "deleted-123", "x".repeat(51)]) {
      expect(await fails(checkedProfileName(influencers, asha, "username", bad))).toMatch(/can contain only lowercase letters/);
    }
    expect(await fails(checkedProfileName(influencers, asha, "username", "RAVI"))).toBe("That username is already taken.");
  });

  it("a link name that was never set may stay empty, but can't be cleared once set", async () => {
    const bare = String((await db.conn.collection("brands").insertOne({ email: "bare@x.in", brandName: "Bare Brand" })).insertedId);
    expect(await checkedProfileName(brands, bare, "brandUsername", "")).toBe("");
    expect(await fails(checkedProfileName(brands, mine, "brandUsername", ""))).toMatch(/can contain only/);
  });

  it("an older name in a form sign-up no longer allows stays as long as it isn't changed", async () => {
    expect(await checkedProfileName(influencers, legacy, "username", "Old.Name")).toBe("Old.Name");
    expect(await checkedProfileName(influencers, legacy, "username", "old.name")).toBe("Old.Name");
  });
});
