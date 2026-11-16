jest.mock("../utils/app-email.service", () => ({ sendAppEmail: jest.fn().mockResolvedValue(undefined) }));

import { ObjectId } from "mongodb";
import { sendAppEmail } from "../utils/app-email.service";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";
import { buildScorecard, scorecardEmailText, sourceLabel } from "./growth-scorecard";
import { GrowthService } from "./growth.service";
import { markShortlistSignup, parseShortlistInput, SHORTLIST_REQUESTS } from "./shortlist-request.util";

jest.setTimeout(DB_TEST_TIMEOUT_MS);
const DAY = 24 * 60 * 60 * 1000;

describe("growth (real MongoDB, 2026-11-16)", () => {
  let db: TestDb;
  let service: GrowthService;
  beforeAll(async () => {
    db = await startTestDb();
    service = new GrowthService(db.conn as any);
  });
  afterAll(() => db.stop());

  it("scorecard: outside brands only, invites, accept rate, active creators, sources", async () => {
    const d = db.conn.db as any;
    const now = new Date();
    const ago = (n: number) => new Date(now.getTime() - n * DAY);
    const house = new ObjectId();
    const outsideOld = new ObjectId();
    const outsideNew = new ObjectId();
    await d.collection("brands").insertMany([
      { _id: house, adminTags: ["Founder-owned"], createdAt: ago(200) },
      { _id: outsideOld, createdAt: ago(100), signupAttribution: { source: "ig" } },
      { _id: outsideNew, createdAt: ago(5), signupAttribution: { source: "whatsapp" } },
    ]);
    const live = new ObjectId();
    await d.collection("campaigns").insertMany([
      { brandId: String(house), slotUsedAt: ago(2), ownerType: "brand" },
      { brandId: String(outsideOld), slotUsedAt: ago(60), ownerType: "brand" },
      { brandId: String(outsideNew), slotUsedAt: ago(1), ownerType: "brand" },
      { _id: live, brandId: String(outsideNew), status: "active" },
    ]);
    await d.collection("campaigninvites").insertMany([
      { campaignId: String(live), status: "pending", createdAt: ago(2) }, // unanswered 48h
      { campaignId: String(live), status: "pending", createdAt: ago(0.5) }, // too fresh
      { campaignId: String(live), status: "accepted", acceptedAt: ago(9), createdAt: ago(10) },
      { campaignId: String(live), status: "declined", createdAt: ago(12) },
      { campaignId: String(live), status: "approved", completedAt: ago(3), acceptedAt: ago(20), createdAt: ago(21) },
    ]);
    await d.collection("influencers").insertMany([
      { status: "accepted", lastOpenedAt: ago(3), createdAt: ago(10), signupAttribution: { source: "instagram" } },
      { status: "accepted", lastLoginAt: ago(90), createdAt: ago(100) },
      { status: "accepted", lastLoginAt: ago(1), adminTags: ["Internal/Test"], createdAt: ago(2) },
    ]);
    await d.collection(SHORTLIST_REQUESTS).insertOne({ status: "new", createdAt: now });

    const card = await buildScorecard(d, now);
    expect(card.outsideBrands).toEqual({ total: 2, newThisWeek: 1 });
    expect(card.invitesSent).toEqual({ last7: 2, previous7: 2 });
    expect(card.acceptRate).toEqual({ accepted: 2, sent: 3, percent: 67 });
    expect(card.workFinished30d).toBe(1);
    expect(card.activeCreators30d).toBe(1);
    expect(card.unansweredInvites).toBe(1);
    expect(card.newShortlistRequests).toBe(1);
    expect(card.signupsBySource.rows).toEqual(
      expect.arrayContaining([
        { source: "instagram", creators: 1, brands: 0 },
        { source: "whatsapp", creators: 0, brands: 1 },
      ]),
    );
    expect(card.signupsBySource.rows.find((r) => r.source === "ig")).toBeUndefined();
    expect(scorecardEmailText(card, "https://x/admin/growth")).toContain("Outside brands with a live campaign: 2 (1 new this week)");

    const rows = await service.unansweredInvites();
    expect(rows).toHaveLength(1);
    expect(rows[0].hoursWaiting).toBeGreaterThanOrEqual(47);
  });

  it("shortlist request: validated, emailed to admin once, repeats within a day update it", async () => {
    const body = {
      name: "Ravi",
      businessName: "Ravi Sarees <b>",
      phone: "+91 98765 43210",
      state: "Telangana",
      city: "Warangal",
      category: "Fashion",
      budget: "5k_20k",
      attribution: { source: "WhatsApp", campaign: "community-tg" },
    };
    await service.createRequest(body);
    await service.createRequest({ ...body, note: "Saree launch" });
    const docs = await db.conn.collection(SHORTLIST_REQUESTS).find({ phone: "9876543210" }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ status: "new", businessName: "Ravi Sarees b", note: "Saree launch", attribution: { source: "whatsapp" } });
    expect(sendAppEmail).toHaveBeenCalledTimes(1);

    // A bot filling the hidden field is accepted silently and not stored.
    await service.createRequest({ ...body, phone: "9123456780", website: "spam.example" });
    expect(await db.conn.collection(SHORTLIST_REQUESTS).countDocuments({ phone: "9123456780" })).toBe(0);

    const updated: any = await service.updateRequest(String(docs[0]._id), { status: "contacted", adminNote: "Sent 5" }, "admin1");
    expect(updated.status).toBe("contacted");
    expect(updated.contactedAt).toBeTruthy();
    await expect(service.updateRequest(String(docs[0]._id), { status: "won" }, "admin1")).rejects.toThrow("Status must be");
  });

  it("signup link prefills only with the right code, and the signup marks the request converted", async () => {
    const col = db.conn.collection(SHORTLIST_REQUESTS);
    const { insertedId } = await col.insertOne({
      name: "Asha", businessName: "Asha Foods", phone: "9000000001", state: "Telangana", city: "Hyderabad",
      category: "Food", budget: "not_sure", status: "contacted", createdAt: new Date(),
    });
    const { link } = await service.signupLink(String(insertedId));
    const again = await service.signupLink(String(insertedId));
    expect(again.link).toBe(link);
    const ref = new URL(link).searchParams.get("shortlist")!;
    expect(new URL(link).searchParams.get("utm_medium")).toBe("shortlist");
    expect(await service.prefill(ref)).toEqual({
      name: "Asha", businessName: "Asha Foods", phone: "9000000001", state: "Telangana", city: "Hyderabad", category: "Food",
    });
    await expect(service.prefill(`${insertedId}.${"0".repeat(32)}`)).rejects.toThrow("expired");
    await expect(service.prefill("nonsense")).rejects.toThrow("isn't valid");

    expect(await markShortlistSignup(db.conn.db, ref, "brand-1")).toBe(true);
    expect(await markShortlistSignup(db.conn.db, ref, "brand-2")).toBe(false);
    const doc: any = await col.findOne({ _id: insertedId });
    expect(doc).toMatchObject({ status: "converted", brandId: "brand-1" });
    await expect(service.prefill(ref)).rejects.toThrow("already used");
  });

  it("build shortlist: creators a guest can open in the state, niche first", async () => {
    const d = db.conn.db as any;
    const pub = (over: any) => ({
      status: "accepted", verificationStatus: "approved", profileVisibility: "PUBLIC", isEmailVerified: true, isMobileVerified: true,
      profileImages: [{ url: "x", public_id: "x" }],
      socialMedia: [{ handle: "h", tier: "Micro" }],
      ...over,
    });
    await d.collection("influencers").insertMany([
      pub({ name: "Niche", publicId: "INF9001", location: { state: "Kerala", district: "Kochi" }, categories: ["Travel"] }),
      pub({ name: "Other", publicId: "INF9002", location: { state: "Kerala", district: "Kochi" }, categories: ["Comedy"] }),
      pub({ name: "Hidden", publicId: "INF9003", location: { state: "Kerala" }, categories: ["Travel"], profileVisibility: "MEMBERS_ONLY" }),
      pub({ name: "Elsewhere", publicId: "INF9004", location: { state: "Goa" }, categories: ["Travel"] }),
    ]);
    const { insertedId } = await db.conn.collection(SHORTLIST_REQUESTS).insertOne({
      name: "B", businessName: "Kochi Tours", phone: "9000000002", state: "Kerala", city: "Kochi", category: "Travel", budget: "not_sure", status: "new", createdAt: new Date(),
    });
    const res = await service.matchesFor(String(insertedId));
    expect(res.inNiche).toBe(1);
    expect(res.candidates.map((c: any) => [c.name, c.inNiche])).toEqual([["Niche", true], ["Other", false]]);
  });

  it("input rules and source labels", () => {
    expect(parseShortlistInput({ name: "A" }).error).toBe("Please add your name.");
    expect(parseShortlistInput({ name: "Ann", businessName: "Shop", phone: "12345" }).error).toContain("10-digit");
    expect(parseShortlistInput({ name: "Ann", businessName: "Shop", phone: "9876543210", state: "TS", category: "Food", budget: "lots" }).error).toBe("Please choose a budget.");
    expect(sourceLabel("IG")).toBe("instagram");
    expect(sourceLabel("")).toBe("unknown");
  });
});
