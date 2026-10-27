import { previewImageUrl, SitemapController } from "./sitemap.controller";
import { BrandSchema, InfluencerSchema, PhotographerSchema } from "./database/schemas/profile.schemas";
import { ProfileFlagSchema } from "./database/schemas/profile-flag.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "./testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** The sitemap asks Google to index profiles — only ones a logged-out visitor may see. */
describe("sitemap lists only public profiles (real MongoDB)", () => {
  let db: TestDb;
  let ctrl: SitemapController;
  beforeAll(async () => {
    db = await startTestDb();
    ctrl = new SitemapController(
      db.conn.model("Influencer", InfluencerSchema, "influencers"),
      db.conn.model("Brand", BrandSchema, "brands"),
      db.conn.model("Photographer", PhotographerSchema, "photographers"),
      db.conn.model("ProfileFlag", ProfileFlagSchema, "profile_flags"),
    );
  });
  afterAll(() => db.stop());

  const listed = async () => {
    let xml = "";
    await ctrl.getSitemap({ type: () => undefined, setHeader: () => undefined, send: (b: string) => (xml = b) } as any);
    return [...xml.matchAll(/<loc>https:\/\/trendstarz\.in\/(?:influencer|brand|photographer)\/([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  };

  it("leaves out Private, Members-only, pending, deleted and flag-hidden profiles", async () => {
    const ok = {
      status: "accepted",
      isEmailVerified: true,
      isMobileVerified: true,
      verificationStatus: "approved",
      location: { state: "Telangana" },
    };
    const creator = { ...ok, profileImages: ["https://res.cloudinary.com/x/a.jpg"], socialMedia: [{ handle: "h", tier: "Nano" }] };
    // Each account needs its own email (unique index).
    const withEmail = (rows: any[]) => rows.map((r) => ({ ...r, email: `${r.username || r.brandUsername}@example.in` }));
    const [flaggedRow] = withEmail([{ ...creator, username: "flagged" }]);
    const flagged = await db.conn.collection("influencers").insertOne(flaggedRow);
    await db.conn.collection("influencers").insertMany(withEmail([
      { ...creator, username: "public-one" },
      { ...creator, username: "no-setting" }, // no visibility saved: counts as Public
      { ...creator, username: "private-one", profileVisibility: "PRIVATE" },
      { ...creator, username: "members-one", profileVisibility: "MEMBERS_ONLY" },
      { ...creator, username: "pending-one", status: "pending" },
      { ...creator, username: "deleted-one", isDeleted: true },
      { ...creator, username: "unapproved", verificationStatus: "pending" },
    ]));
    await db.conn.collection("profile_flags").insertOne({ userId: String(flagged.insertedId), userType: "Influencer", status: "Open", flagCode: "LOCATION_MISSING" });

    const brand = { ...ok, brandLogo: ["https://res.cloudinary.com/x/b.jpg"] };
    await db.conn.collection("brands").insertMany(withEmail([
      { ...brand, brandUsername: "brand-public" }, // no social needed for brands
      { ...brand, brandUsername: "brand-private", profileVisibility: "PRIVATE" },
      { ...brand, brandUsername: "brand-deleted", status: "deleted", isDeleted: true },
      { ...brand, brandUsername: "brand-pending", status: "pending" },
    ]));
    await db.conn.collection("photographers").insertMany(withEmail([
      { ...creator, username: "photo-public" },
      { ...creator, username: "photo-private", profileVisibility: "PRIVATE" },
    ]));

    expect(await listed()).toEqual(["brand-public", "no-setting", "photo-public", "public-one"]);
  });

  it("gives link previews only for the same public profiles", async () => {
    const preview = (kind: string, slug: string) => ctrl.getSharePreview(kind, slug).catch((e) => e.status);
    await db.conn.collection("influencers").updateOne(
      { username: "public-one" },
      { $set: { name: "Asha Rao", categories: ["Fashion", "Travel"], location: { state: "Telangana", district: "Hyderabad" }, profileImages: [{ url: "https://res.cloudinary.com/demo/image/upload/v17/a.jpg" }] } },
    );
    expect(await preview("influencer", "public-one")).toEqual({
      title: "Asha Rao — Creator on TrendStarz",
      description: "Fashion · Travel. Creator in Hyderabad, Telangana. View the profile and invite on TrendStarz.",
      image: "https://res.cloudinary.com/demo/image/upload/c_fill,w_600,h_600,q_auto,f_jpg/v17/a.jpg",
      url: "https://trendstarz.in/influencer/public-one",
    });
    for (const [kind, slug] of [
      ["influencer", "private-one"],
      ["influencer", "members-one"],
      ["influencer", "pending-one"],
      ["influencer", "deleted-one"],
      ["influencer", "flagged"],
      ["influencer", "photo-public"], // wrong kind
      ["photographer", "photo-private"],
      ["brand", "brand-private"],
      ["brand", "brand-deleted"],
      ["brand", "brand-pending"],
      ["influencer", ".*"], // never a pattern
      ["anything", "public-one"],
    ]) {
      expect({ kind, slug, got: await preview(kind, slug) }).toEqual({ kind, slug, got: 404 });
    }
    expect((await preview("brand", "BRAND-PUBLIC")).url).toBe("https://trendstarz.in/brand/brand-public");
    expect((await preview("photographer", "photo-public")).title).toContain("Photographer / videographer");
  });

  it("only resizes Cloudinary photos that have no resizing yet", () => {
    expect(previewImageUrl("https://res.cloudinary.com/d/image/upload/c_fill,w_100/v1/a.jpg")).toBe("https://res.cloudinary.com/d/image/upload/c_fill,w_100/v1/a.jpg");
    expect(previewImageUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
    expect(previewImageUrl(undefined)).toBe("");
  });
});
