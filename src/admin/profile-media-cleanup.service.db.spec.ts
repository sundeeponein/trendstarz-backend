import { ProfileMediaCleanupService, publicIdFromCloudinaryUrl } from "./profile-media-cleanup.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

const ID = "6a65de337f69122aa773bd67";
const OLD = "2026-01-01T00:00:00Z";

describe("ProfileMediaCleanupService (real MongoDB)", () => {
  let db: TestDb;
  let settings: any;

  beforeAll(async () => {
    db = await startTestDb();
    settings = db.conn.collection("appsettings");
  });
  afterAll(async () => db?.stop());

  function serviceWith(files: Array<{ public_id: string; created_at?: string }>) {
    const deleted: string[] = [];
    const cloudinary: any = {
      isEnabled: () => true,
      listResourcesOlderThan: async (prefix: string) =>
        files
          .filter((f) => f.public_id.startsWith(prefix))
          .map((f) => ({ public_id: f.public_id, created_at: f.created_at || OLD })),
      deleteImage: async (id: string) => {
        deleted.push(id);
        return { result: "ok" };
      },
    };
    const appSettings: any = {
      findOne: () => ({ lean: async () => settings.findOne({}) }),
      findOneAndUpdate: async (_f: any, update: any) => settings.updateOne({}, update, { upsert: true }),
    };
    return { service: new ProfileMediaCleanupService(db.conn as any, appSettings, cloudinary), deleted };
  }

  it("reads public_ids from Cloudinary URLs with transformations and versions", () => {
    expect(
      publicIdFromCloudinaryUrl(
        `https://res.cloudinary.com/x/image/upload/f_auto,q_auto,w_220/v1712/influencers/${ID}/profile/abc.jpg`,
      ),
    ).toBe(`influencers/${ID}/profile/abc`);
  });

  it("deletes only unused profile media; keeps anything mentioned anywhere and other folders", async () => {
    await db.conn.collection("influencers").insertOne({
      profileImages: [{ url: "x", public_id: `influencers/${ID}/profile/inuse` }],
    });
    // Mentioned only by URL inside an unrelated collection: still in use.
    await db.conn.collection("campaigns").insertOne({
      images: [`https://res.cloudinary.com/x/image/upload/v1/influencers/${ID}/gallery/copied.jpg`],
    });
    const files = [
      { public_id: `influencers/${ID}/profile/inuse` },
      { public_id: `influencers/${ID}/gallery/copied` },
      { public_id: `influencers/${ID}/gallery/orphan1` },
      { public_id: `influencers/${ID}/profile/orphan2` },
      { public_id: `influencers/${ID}/verification/doc` }, // never swept
      { public_id: "influencers/_pending/profile/p" }, // never swept here
    ];
    // Lots of in-use files so the "more than half unused" brake doesn't trip.
    for (let i = 0; i < 25; i++) {
      files.push({ public_id: `brands/${ID}/logo/keep${i}` });
      await db.conn.collection("brands").insertOne({ brandLogo: [{ public_id: `brands/${ID}/logo/keep${i}` }] });
    }
    const { service, deleted } = serviceWith(files);

    const preview: any = await service.runCleanupNow("test", true);
    expect(preview.sample.sort()).toEqual([`influencers/${ID}/gallery/orphan1`, `influencers/${ID}/profile/orphan2`]);
    expect(deleted).toEqual([]);

    await service.runCleanupNow("test");
    expect(deleted.sort()).toEqual([`influencers/${ID}/gallery/orphan1`, `influencers/${ID}/profile/orphan2`]);
    expect((await settings.findOne({})).profileMediaCleanupLastRunCount).toBe(2);
  });

  it("stops without deleting when most files look unused (a scan gone wrong)", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ public_id: `photographers/${ID}/gallery/x${i}` }));
    const { service, deleted } = serviceWith(files);
    const result: any = await service.runCleanupNow("test");
    expect(result.note).toMatch(/^stopped/);
    expect(deleted).toEqual([]);
  });

  it("does nothing when switched off in settings", async () => {
    await settings.updateOne({}, { $set: { profileMediaCleanupEnabled: false } }, { upsert: true });
    const { service, deleted } = serviceWith([{ public_id: `influencers/${ID}/gallery/z` }]);
    expect(await service.runCleanupNow("test")).toMatchObject({ skipped: true, reason: "disabled" });
    expect(deleted).toEqual([]);
    await settings.updateOne({}, { $unset: { profileMediaCleanupEnabled: "" } });
  });
});
