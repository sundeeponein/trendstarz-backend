import { Types } from "mongoose";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "./mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** The open-report and still-disputed queries use an index, not a scan of every invite. */
describe("invite report queries use an index (real MongoDB)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    await db.conn.model("CampaignInvite", CampaignInviteSchema, "campaigninvites").init();
    await db.conn.collection("campaigninvites").insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        campaignId: new Types.ObjectId().toHexString(),
        influencerId: new Types.ObjectId(),
        status: i === 0 ? "disputed" : "accepted",
        ...(i < 2 ? { reportedIssue: { reportedAt: new Date() } } : {}),
      })),
    );
  });
  afterAll(() => db.stop());

  const plan = async (filter: any) => JSON.stringify((await db.conn.collection("campaigninvites").find(filter).explain()).queryPlanner.winningPlan);

  it("open reports", async () => {
    const p = await plan({ "reportedIssue.reportedAt": { $ne: null }, "reportedIssue.resolvedAt": { $in: [null, undefined] } });
    expect(p).toContain("reportedIssue.reportedAt_1");
    expect(p).not.toContain("COLLSCAN");
  });

  it("still-disputed invites", async () => {
    expect(await plan({ status: "disputed" })).not.toContain("COLLSCAN");
  });
});
