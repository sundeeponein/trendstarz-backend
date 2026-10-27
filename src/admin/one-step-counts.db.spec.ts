import { AdminUserTableController } from "./admin-user-table.controller";
import { BrandSchema, InfluencerSchema, PhotographerSchema } from "../database/schemas/profile.schemas";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** Data health "One step from Search": accounts hidden for one reason an admin can fix. */
describe("one step from Search (real MongoDB)", () => {
  let db: TestDb;
  let ctrl: any;
  beforeAll(async () => {
    db = await startTestDb();
    ctrl = Object.assign(Object.create(AdminUserTableController.prototype), {
      influencerModel: db.conn.model("Influencer", InfluencerSchema, "influencers"),
      brandModel: db.conn.model("Brand", BrandSchema, "brands"),
      photographerModel: db.conn.model("Photographer", PhotographerSchema, "photographers"),
      flagModel: db.conn.model("ProfileFlag", ProfileFlagSchema, "profile_flags"),
    });
  });
  afterAll(() => db.stop());

  it("counts each list the way the users table filters it", async () => {
    const complete = {
      status: "accepted",
      isEmailVerified: true,
      isMobileVerified: true,
      location: { state: "Telangana" },
      profileImages: [{ url: "https://res.cloudinary.com/x/a.jpg", public_id: "a" }],
      socialMedia: [{ handle: "h", tier: "Nano" }],
    };
    const approved = { ...complete, verificationStatus: "approved" };
    let n = 0;
    const row = (extra: object) => ({ ...complete, email: `u${++n}@x.in`, username: `u${n}`, ...extra });
    const flagged = await db.conn.collection("influencers").insertOne(row({ verificationStatus: "not_submitted" }));
    await db.conn.collection("influencers").insertMany([
      row({ ...approved }), // already in Search: in no list
      row({ verificationStatus: "not_submitted" }), // waiting for approval
      row({ verificationStatus: "pending", profileVisibility: "MEMBERS_ONLY" }), // waiting (brands search logged in)
      row({ verificationStatus: "not_submitted", profileVisibility: "PRIVATE" }), // their choice: no list
      row({ verificationStatus: "not_submitted", profileImages: [] }), // more than one step: no list
      row({ verificationStatus: "not_submitted", isMobileVerified: false }), // two steps: no list
      row({ ...approved, isMobileVerified: false }), // only mobile
      row({ ...approved, isMobileVerified: false, isDeleted: true }), // deleted: no list
      row({ ...approved, adminReviewPending: true }), // back in review, nothing flagged: admin to-do
    ]);
    // Re-review where the admin already flagged something (non-hiding flag): creator must fix.
    const reviewed = await db.conn.collection("influencers").insertOne(row({ ...approved, adminReviewPending: true }));
    await db.conn.collection("profile_flags").insertMany([
      { userId: String(flagged.insertedId), userType: "Influencer", status: "Open", flagCode: "LOCATION_MISSING" },
      { userId: String(reviewed.insertedId), userType: "Influencer", status: "Open", flagCode: "PORTFOLIO_MISSING" },
      { userId: String(reviewed.insertedId), userType: "Influencer", status: "Resolved", flagCode: "TIER_MISMATCH" },
    ]);

    const r = await ctrl.oneStepCounts();
    expect(r.counts.waiting_approval.influencer).toBe(2);
    expect(r.counts.mobile_only.influencer).toBe(1);
    expect(r.counts.back_in_review.influencer).toBe(1);
    // The location-flagged account (hidden from Search) and the flagged re-review.
    expect(r.counts.waiting_on_creator.influencer).toBe(2);
    expect(r.creatorFlagReasons.influencer).toEqual({ LOCATION_MISSING: 1, PORTFOLIO_MISSING: 1 });
    expect(r.counts.waiting_approval.brand).toBe(0);
  });
});
