import { Types } from "mongoose";
import { CampaignsService } from "./campaigns.service";
import { CampaignInvitesService } from "./campaign-invites.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("who may see a campaign and its submission (real MongoDB)", () => {
  let db: TestDb;
  let Campaign: any;
  let Invite: any;
  const owner = new Types.ObjectId().toHexString();
  const creator = new Types.ObjectId();
  const stranger = new Types.ObjectId().toHexString();
  let draftId: string;
  let liveId: string;
  let inviteId: string;

  beforeAll(async () => {
    db = await startTestDb();
    const { Schema } = require("mongoose");
    Campaign = db.conn.model("CampaignVis", new Schema({}, { strict: false }), "campaigns");
    Invite = db.conn.model("InviteVis", new Schema({}, { strict: false }), "campaigninvites");
    const base = { brandId: owner, moderationNote: "internal", adminOverrideReason: "secret", title: "T" };
    draftId = String((await Campaign.create({ ...base, status: "draft" }))._id);
    liveId = String((await Campaign.create({ ...base, status: "active" }))._id);
    inviteId = String((await Invite.create({ campaignId: draftId, brandId: owner, influencerId: creator }))._id);
    await db.conn.collection("campaignsubmissions").insertOne({ inviteId: new Types.ObjectId(inviteId), postUrl: "x" });
  });
  afterAll(async () => db?.stop());

  const view = (id: string, who: string, role = "influencer") =>
    (CampaignsService.prototype as any).findForViewer.call(
      { campaignModel: Campaign, campaignInviteModel: Invite },
      id,
      { id: who, role },
    );

  it("owner and admin see everything, including moderation notes", async () => {
    expect((await view(draftId, owner, "brand")).moderationNote).toBe("internal");
    expect((await view(draftId, stranger, "admin")).adminOverrideReason).toBe("secret");
  });

  it("others see live campaigns without admin fields, and never someone's draft", async () => {
    const live = await view(liveId, stranger);
    expect(live.title).toBe("T");
    expect(live.moderationNote).toBeUndefined();
    expect(live.adminOverrideReason).toBeUndefined();
    await expect(view(draftId, stranger)).rejects.toThrow("not found");
  });

  it("an invited creator sees the campaign (without admin fields) even before it is live", async () => {
    const seen = await view(draftId, String(creator));
    expect(seen.title).toBe("T");
    expect(seen.moderationNote).toBeUndefined();
  });

  it("a submission is visible to its creator, the host and admins only", async () => {
    const ctx = {
      inviteModel: Invite,
      submissionModel: {
        findOne: (q: any) => ({ populate: () => ({ lean: () => db.conn.collection("campaignsubmissions").findOne({ inviteId: new Types.ObjectId(String(q.inviteId)) }) }) }),
      },
    };
    const get = (who: string, role = "influencer") =>
      (CampaignInvitesService.prototype as any).getSubmissionByInvite.call(ctx, inviteId, { id: who, role });
    expect((await get(String(creator))).submission.postUrl).toBe("x");
    expect((await get(owner, "brand")).submission.postUrl).toBe("x");
    expect((await get(stranger, "admin")).submission.postUrl).toBe("x");
    await expect(get(stranger)).rejects.toThrow("not found");
  });
});
