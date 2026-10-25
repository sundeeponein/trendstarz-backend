import { Types } from "mongoose";
import { InfluencersController, DASHBOARD_SEARCH_LIMIT } from "./influencers.controller";
import { InfluencerSchema } from "../database/schemas/profile.schemas";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("brand dashboard influencer search (real MongoDB)", () => {
  let db: TestDb;
  let controller: InfluencersController;

  const discoverable = (over: Record<string, any> = {}) => ({
    _id: new Types.ObjectId(),
    name: "Visible",
    email: `${new Types.ObjectId()}@x.in`,
    status: "accepted",
    verificationStatus: "approved",
    isEmailVerified: true,
    isMobileVerified: true,
    profileImages: [{ url: "https://res.cloudinary.com/x/a.jpg", public_id: "a" }],
    location: { state: "Telangana" },
    socialMedia: [{ handle: "visible", tier: "Micro" }],
    categories: ["Fashion"],
    ...over,
  });

  beforeAll(async () => {
    db = await startTestDb();
    controller = new InfluencersController(
      db.conn.model("Influencer", InfluencerSchema, "influencers") as any,
      db.conn.model("ProfileFlag", ProfileFlagSchema, "profile_flags") as any,
    );
  });
  afterAll(() => db.stop());

  it("shows only creators Search would show, and at most the dashboard limit", async () => {
    const flagged = discoverable({ name: "Flagged photo" });
    await db.conn.collection("influencers").insertMany([
      discoverable(),
      discoverable({ name: "Unapproved", verificationStatus: "pending" }),
      discoverable({ name: "Private", profileVisibility: "PRIVATE" }),
      discoverable({ name: "No mobile", isMobileVerified: false }),
      discoverable({ name: "Deleted", isDeleted: true }),
      flagged,
    ]);
    await db.conn.collection("profile_flags").insertOne({
      userId: String(flagged._id), userType: "Influencer", status: "Open", flagCode: "PROFILE_PHOTO_BLURRY",
    });

    const rows: any[] = await controller.searchInfluencers({ category: "Fashion" });
    expect(rows.map((r) => r.name)).toEqual(["Visible"]);

    await db.conn.collection("influencers").insertMany(
      Array.from({ length: DASHBOARD_SEARCH_LIMIT + 5 }, () => discoverable({ name: "Many" })),
    );
    expect((await controller.searchInfluencers({})).length).toBe(DASHBOARD_SEARCH_LIMIT);
  });
});
