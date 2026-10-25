import { Types } from "mongoose";
import { ProfileVerificationService } from "./profile-verification.service";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { BrandSchema, InfluencerSchema, PhotographerSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("nightly refresh of stored profile completion/score/tier (real MongoDB)", () => {
  let db: TestDb;
  let service: ProfileVerificationService;

  beforeAll(async () => {
    db = await startTestDb();
    const m = (name: string, schema: any, col: string) => db.conn.model(name, schema, col);
    service = new ProfileVerificationService(
      m("ProfileFlag", ProfileFlagSchema, "profile_flags"),
      m("Influencer", InfluencerSchema, "influencers"),
      m("Brand", BrandSchema, "brands"),
      m("Photographer", PhotographerSchema, "photographers"),
      {} as any,
      {} as any,
    );
  });
  afterAll(() => db.stop());

  it("rewrites stale stored values to what the dashboard would show, and skips deleted accounts", async () => {
    const live = new Types.ObjectId();
    const deleted = new Types.ObjectId();
    const stale = { profileCompletion: 100, profileQualityScore: 100, profileTier: "Outstanding Profile" };
    await db.conn.collection("influencers").insertMany([
      { _id: live, name: "Asha", email: "a@x.in", status: "accepted", ...stale },
      { _id: deleted, name: "Gone", email: "g@x.in", isDeleted: true, ...stale },
    ]);

    const result = await service.refreshAllStoredQuality();
    expect(result).toEqual({ checked: 1, failed: 0 });

    const after: any = await db.conn.collection("influencers").findOne({ _id: live });
    const dashboard: any = await service.getDashboard(String(live), "influencer");
    expect(after.profileCompletion).toBe(dashboard.profileCompletion);
    expect(after.profileQualityScore).toBe(dashboard.profileQualityScore);
    expect(after.profileTier).toBe(dashboard.profileTier);
    expect(after.profileTier).not.toBe("Outstanding Profile"); // a bare profile isn't
    expect(await db.conn.collection("profile_flags").countDocuments({ userId: String(live), status: "Open" })).toBeGreaterThan(0);

    const untouched: any = await db.conn.collection("influencers").findOne({ _id: deleted });
    expect(untouched.profileTier).toBe("Outstanding Profile");
    expect(await db.conn.collection("profile_flags").countDocuments({ userId: String(deleted) })).toBe(0);
  });
});
