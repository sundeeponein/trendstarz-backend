/**
 * The data rules the foundation work relies on, checked on a real MongoDB:
 * ID types match the stored shape, money can't go negative, invites are unique
 * per active recipient, and simultaneous invite answers can't both win.
 */
import * as fs from "fs";
import * as path from "path";
import mongoose, { Types } from "mongoose";
import { CampaignTransactionSchema } from "./campaign-transaction.schema";
import { CampaignInviteSchema } from "./campaign-invite.schema";
import { PaymentSchema } from "./payment.schema";
import { UsageCounterSchema } from "./usage-counter.schema";
import { CampaignSubmissionSchema } from "./campaign-submission.schema";
import { PaymentsPayoutsService } from "../../payments-payouts/payments-payouts.service";
import { PendingUserCleanupService } from "../../admin/pending-user-cleanup.service";
import { ImageCleanupService } from "../../plans/image-cleanup.service";
import { EarlyAccessAssignmentService } from "../../admin/early-access-assignment.service";
import { openMoneyFilter, openWorkFilter } from "../../users/self-deletion.util";
import { BrandSchema, InfluencerSchema, PhotographerSchema } from "./profile.schemas";
import { idIn, idsIn } from "../../utils/id-match.util";
import { anyId } from "../../payments-payouts/campaign-refund.util";
import { ACTIVE_INVITE_STATUSES } from "../../campaigns/reinvite-rule.util";
import { CampaignInvitesService } from "../../campaigns/campaign-invites.service";
import {
  isUnexcusedNoShow,
  slotHoldingInviteMatch,
} from "../../campaigns/creator-monthly-slots.util";
import {
  DB_TEST_TIMEOUT_MS,
  startTestDb,
  TestDb,
} from "../../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("data rules (real MongoDB)", () => {
  let db: TestDb;
  let Tx: mongoose.Model<any>;
  let Invite: mongoose.Model<any>;
  let Payment: mongoose.Model<any>;

  const txBase = () => ({
    transactionType: "paid_collab",
    direction: "brand_to_influencer",
    campaignId: new Types.ObjectId().toHexString(),
    inviteId: new Types.ObjectId(),
    payerId: new Types.ObjectId().toHexString(),
    payerRole: "brand",
    recipientId: new Types.ObjectId().toHexString(),
    recipientRole: "influencer",
    agreedAmount: 100000,
    platformFee: 5000,
    payerTotal: 105000,
    recipientPayout: 100000,
  });

  beforeAll(async () => {
    db = await startTestDb();
    Tx = db.conn.model("CampaignTransaction", CampaignTransactionSchema, "campaigntransactions");
    Invite = db.conn.model("CampaignInvite", CampaignInviteSchema, "campaigninvites");
    Payment = db.conn.model("Payment", PaymentSchema, "payments");
    await Promise.all([Tx, Invite, Payment].map((m) => m.init()));
  });
  afterAll(() => db.stop());

  describe("ID types", () => {
    it("rows stored in the production shape match every query form the code uses", async () => {
      const camp = new Types.ObjectId();
      const inv = new Types.ObjectId();
      const brand = new Types.ObjectId();
      // Written raw, bypassing the schema — exactly how existing prod rows look.
      await db.conn.collection("campaigntransactions").insertOne({
        ...txBase(),
        campaignId: camp.toHexString(),
        inviteId: inv,
        payerId: brand.toHexString(),
      });
      for (const q of [
        { campaignId: camp },
        { campaignId: camp.toHexString() },
        { campaignId: idIn(camp) },
        { payerId: brand },
        { inviteId: inv.toHexString() },
        { inviteId: idIn(inv) },
        { inviteId: anyId(inv) },
        { inviteId: idsIn([inv.toHexString()]) },
      ]) {
        expect(await Tx.countDocuments(q)).toBe(1);
      }
    });

    it("new writes are stored in that same shape whatever type the code passes", async () => {
      const t = await Tx.create({
        ...txBase(),
        campaignId: new Types.ObjectId(),
        inviteId: new Types.ObjectId().toHexString(),
        feeInviteId: new Types.ObjectId().toHexString(),
        disputedBy: new Types.ObjectId(),
      });
      const raw: any = await db.conn.collection("campaigntransactions").findOne({ _id: t._id });
      expect(typeof raw.campaignId).toBe("string");
      expect(typeof raw.payerId).toBe("string");
      expect(typeof raw.disputedBy).toBe("string");
      expect(raw.inviteId).toBeInstanceOf(Types.ObjectId);
      expect(raw.feeInviteId).toBeInstanceOf(Types.ObjectId);
    });
  });

  describe("money", () => {
    it("rejects a negative amount on a transaction, invite or payment", async () => {
      await expect(Tx.create({ ...txBase(), payerTotal: -1 })).rejects.toThrow(/payerTotal/);
      await expect(
        Invite.create({ campaignId: "c", brandId: "b", influencerId: new Types.ObjectId(), agreedAmountPaise: -100 }),
      ).rejects.toThrow(/agreedAmountPaise/);
      await expect(
        Payment.create({ userType: "Brand", transactionId: "t-neg", amount: -1, premiumDuration: "1m" }),
      ).rejects.toThrow(/amount/);
    });
  });

  describe("account status", () => {
    it("every profile type can store the self-deletion grace status (Settings → Delete account)", async () => {
      for (const [name, schema] of [
        ["Influencer", InfluencerSchema],
        ["Brand", BrandSchema],
        ["Photographer", PhotographerSchema],
      ] as const) {
        const M = db.conn.model(name, schema as any, name.toLowerCase() + "s");
        const doc: any = new M({
          name: "A", brandName: "A", email: `${name}@x.com`, password: "x", phoneNumber: "1", username: `u_${name}`,
          status: "deletion_pending", isDeleted: true,
        });
        await expect(doc.validate()).resolves.toBeUndefined();
      }
    });
  });

  describe("one active invite per campaign + recipient", () => {
    beforeAll(async () => {
      // The same partial unique index cron/uniqueConstraints.js builds on prod.
      await db.conn.collection("campaigninvites").createIndex(
        { campaignId: 1, influencerId: 1 },
        {
          name: "uniq_active_invite_per_recipient",
          unique: true,
          partialFilterExpression: { status: { $in: [...ACTIVE_INVITE_STATUSES] } },
        },
      );
    });

    it("the cron script and the code agree on which statuses are active", () => {
      const script = fs.readFileSync(
        path.join(__dirname, "../../../cron/uniqueConstraints.js"),
        "utf8",
      );
      const list = script.match(/const ACTIVE_INVITE_STATUSES = \[([\s\S]*?)\];/)?.[1] ?? "";
      const cronStatuses = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(cronStatuses).toEqual([...ACTIVE_INVITE_STATUSES].sort());
    });

    it("blocks a second active invite but allows re-inviting after a withdrawal", async () => {
      const key = { campaignId: "camp-u", brandId: "b", influencerId: new Types.ObjectId() };
      await Invite.create({ ...key, status: "withdrawn" });
      await Invite.create({ ...key, status: "pending" }); // re-invite after withdrawal
      await expect(Invite.create({ ...key, status: "pending" })).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe("creator monthly slots", () => {
    it("the admin 'excuse' rule and the slot count agree on which closed invites hold a slot", async () => {
      const creator = new Types.ObjectId();
      const rows = [
        { withdrawnReasonCode: "expired_unsubmitted" },
        { withdrawnReasonCode: "location_no_show" },
        { withdrawnReasonCode: "expired_unsubmitted", missExcused: { at: new Date() } },
        { withdrawnReasonCode: "host_cancelled" },
        { withdrawnReason: "Posting deadline and grace period expired with no submission." },
        { withdrawnReason: "Withdrawn by host" },
      ].map((r) => ({ campaignId: new Types.ObjectId().toHexString(), brandId: "b", influencerId: creator, status: "withdrawn", ...r }));
      await db.conn.collection("campaigninvites").insertMany(rows);

      const holding = await db.conn
        .collection("campaigninvites")
        .find({ influencerId: creator, ...slotHoldingInviteMatch() })
        .toArray();
      const holdingIds = new Set(holding.map((d: any) => String(d._id)));
      const all = await db.conn.collection("campaigninvites").find({ influencerId: creator }).toArray();
      for (const inv of all) {
        expect(isUnexcusedNoShow(inv)).toBe(holdingIds.has(String(inv._id)));
      }
      expect(holdingIds.size).toBe(3);
    });
  });

  describe("invite fields that used to be dropped", () => {
    it("stores the creator's shipping address and the recipient role", async () => {
      const inv: any = await Invite.create({ campaignId: "c-ship", brandId: "b", influencerId: new Types.ObjectId(), status: "pending", recipientRole: "photographer" });
      inv.status = "accepted";
      inv.shippingAddress = { contactName: "Asha", line1: "12 MG Road", city: "Hyderabad", pincode: "500001", capturedAt: new Date() };
      await inv.save();
      const raw: any = await db.conn.collection("campaigninvites").findOne({ _id: inv._id });
      expect(raw.recipientRole).toBe("photographer");
      expect(raw.shippingAddress).toMatchObject({ line1: "12 MG Road", pincode: "500001" });
    });
  });

  describe("submitting at the deadline vs the hourly expiry", () => {
    it("whichever saves first wins; the other doesn't overwrite it", async () => {
      const { insertedId } = await db.conn.collection("campaigninvites").insertOne({
        campaignId: "camp-race", brandId: "b", influencerId: new Types.ObjectId(), status: "payment_confirmed",
      });
      const creatorCopy: any = await Invite.findById(insertedId);
      const cronCopy: any = await Invite.findById(insertedId);
      // Creator's submission lands first…
      creatorCopy.$where = { status: creatorCopy.status };
      creatorCopy.status = "submitted";
      await creatorCopy.save();
      // …then the expiry, guarded on the status it read, must not close it.
      cronCopy.$where = { status: cronCopy.status };
      cronCopy.status = "withdrawn";
      await expect(cronCopy.save()).rejects.toMatchObject({ name: "DocumentNotFoundError" });
      expect(((await Invite.findById(insertedId).lean()) as any).status).toBe("submitted");
    });
  });

  describe("answering an invite", () => {
    // The real guard from CampaignInvitesService (it doesn't use `this` state).
    const saveIfUnchanged = (doc: any, readState: Record<string, unknown>) =>
      (CampaignInvitesService.prototype as any).saveIfUnchanged.call({}, doc, readState);
    const readState = (d: any) => ({
      status: d.status,
      "counterOffer.status": d?.counterOffer?.status ?? null,
    });

    it("works on an older invite with no counterOffer stored, and only the first answer wins", async () => {
      const { insertedId } = await db.conn.collection("campaigninvites").insertOne({
        campaignId: "camp-a",
        brandId: "b",
        influencerId: new Types.ObjectId(),
        status: "pending",
      });
      const a: any = await Invite.findById(insertedId);
      const b: any = await Invite.findById(insertedId);
      expect(a.counterOffer.status).toBe("none"); // default filled in on load
      const ra = readState(a);
      const rb = readState(b);
      a.status = "accepted";
      await saveIfUnchanged(a, ra);
      b.status = "declined";
      await expect(saveIfUnchanged(b, rb)).rejects.toThrow(/answered meanwhile/);
      expect((await Invite.findById(insertedId).lean() as any).status).toBe("accepted");
    });
  });

  describe("daily usage counters", () => {
    it("rows get createdAt on upsert and expire 90 days later", async () => {
      const Usage = db.conn.model("UsageCounter", UsageCounterSchema, "usage_counters");
      await Usage.init();
      const row: any = await Usage.findOneAndUpdate(
        { userId: new Types.ObjectId(), userRole: "brand", usageType: "search", day: "2026-10-19" },
        { $setOnInsert: { limit: 10, remaining: 10 }, $inc: { used: 1 } },
        { upsert: true, new: true },
      ).lean();
      expect(row.createdAt).toBeInstanceOf(Date);
      const ttl = (await Usage.collection.indexes()).find((i: any) => i.key?.createdAt === 1);
      expect(ttl?.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
    });
  });

  describe("self-deletion blockers", () => {
    it("find open work and unsettled money however the user's id is stored", async () => {
      const creator = new Types.ObjectId();
      const host = new Types.ObjectId().toHexString();
      const campaignId = new Types.ObjectId().toHexString();
      // Invites store the creator as an ObjectId and the host as a string.
      await Invite.collection.insertOne({ campaignId, influencerId: creator, brandId: host, status: "accepted" });
      expect(await Invite.findOne(openWorkFilter(String(creator))).lean()).toBeTruthy();
      expect(await Invite.findOne(openWorkFilter(host)).lean()).toBeTruthy();
      await Invite.collection.updateMany({ campaignId }, { $set: { status: "completed" } });
      expect(await Invite.findOne(openWorkFilter(String(creator))).lean()).toBeNull();

      // Payment rows store both sides as strings.
      const row = await Tx.collection.insertOne({
        ...txBase(),
        payerId: host,
        recipientId: String(creator),
        collectionStatus: "verified",
        payoutStatus: "pending",
      });
      expect(await Tx.findOne(openMoneyFilter(String(creator))).lean()).toBeTruthy();
      expect(await Tx.findOne(openMoneyFilter(host)).lean()).toBeTruthy();
      await Tx.collection.updateOne({ _id: row.insertedId }, { $set: { payoutStatus: "paid" } });
      expect(await Tx.findOne(openMoneyFilter(String(creator))).lean()).toBeNull();
      await Tx.collection.updateOne({ _id: row.insertedId }, { $set: { refundStatus: "owed" } });
      expect(await Tx.findOne(openMoneyFilter(host)).lean()).toBeTruthy();
    });
  });

  describe("a post under review completes when the host stays silent", () => {
    const HOUR = 60 * 60 * 1000;
    // The real job, on real collections; settings and event logging are stand-ins.
    const job = (settings: any) => {
      const Submission = db.conn.models.CampaignSubmission
        || db.conn.model("CampaignSubmission", CampaignSubmissionSchema, "campaignsubmissions");
      const service = Object.create(CampaignInvitesService.prototype);
      Object.assign(service, {
        submissionModel: Submission,
        inviteModel: Invite,
        campaignTransactionModel: Tx,
        appSettingsModel: { findOne: () => ({ lean: async () => settings }) },
        platformEvents: { record: async () => true },
      });
      return { run: () => service.autoApproveStaleSubmissions(), Submission };
    };
    const seed = async (Submission: any, hoursAgo: number, extra: any = {}, inviteStatus = "submitted") => {
      const invite = await Invite.collection.insertOne({
        campaignId: "camp-review", brandId: "b", influencerId: new Types.ObjectId(), status: inviteStatus,
      });
      const sub = await Submission.collection.insertOne({
        campaignId: "camp-review", influencerId: new Types.ObjectId(), inviteId: invite.insertedId,
        postUrl: "https://instagram.com/p/x", status: "submitted",
        submittedAt: new Date(Date.now() - hoursAgo * HOUR), ...extra,
      });
      return { inviteId: invite.insertedId, subId: sub.insertedId };
    };

    it("default (24 h + 0): completes after 24 h; not before, and never one under dispute", async () => {
      const { run, Submission } = job({ submissionApprovalWaitHours: 24, submissionAutoCompleteGraceHours: 0 });
      const due = await seed(Submission, 25);
      const early = await seed(Submission, 10);
      const disputed = await seed(Submission, 30, {}, "disputed");
      await run();
      expect(((await Invite.findById(due.inviteId).lean()) as any).status).toBe("completed");
      expect(((await Submission.findById(due.subId).lean()) as any).autoCompletedAt).toBeInstanceOf(Date);
      expect(((await Invite.findById(early.inviteId).lean()) as any).status).toBe("submitted");
      expect(((await Invite.findById(disputed.inviteId).lean()) as any).status).toBe("disputed");
    });

    it("with extra silent hours, only a host who ticked auto-complete ends it at 24 h", async () => {
      const { run, Submission } = job({ submissionApprovalWaitHours: 24, submissionAutoCompleteGraceHours: 48 });
      const silent = await seed(Submission, 30);
      const ticked = await seed(Submission, 30, { hostAutoCompleteEnabled: true });
      await run();
      expect(((await Invite.findById(silent.inviteId).lean()) as any).status).toBe("submitted");
      expect(((await Invite.findById(ticked.inviteId).lean()) as any).status).toBe("completed");
    });
  });

  describe("resolving a dispute", () => {
    it("two resolvers at the same moment: only the first lands, the second changes no money", async () => {
      const { insertedId } = await Invite.collection.insertOne({
        campaignId: "camp-dispute", brandId: "b", influencerId: new Types.ObjectId(), status: "disputed",
        reportedIssue: { reason: "mismatch", reportedAt: new Date(Date.now() - 48 * 3600e3) },
      });
      await Tx.collection.insertOne({ ...txBase(), inviteId: insertedId, collectionStatus: "verified", payoutStatus: "pending" });
      const tx = { find: jest.fn(), updateMany: jest.fn() };
      const service = Object.create(CampaignInvitesService.prototype);
      Object.assign(service, {
        inviteModel: Invite,
        submissionModel: { findOne: async () => null },
        campaignTransactionModel: tx,
        platformEvents: { record: async () => true },
        recordInviteWithdrawn: async () => undefined,
      });
      // The admin's copy is read first, then the hourly job resolves it for the host…
      const adminCopy: any = await Invite.findById(insertedId);
      jest.spyOn(Invite, "findById").mockResolvedValueOnce(adminCopy as any);
      await Invite.collection.updateOne(
        { _id: insertedId },
        { $set: { status: "withdrawn", "reportedIssue.resolvedAt": new Date() } },
      );
      // …so the admin's "pay the creator" must not land or touch any payment row.
      const result = await (service as any).finalizeDisputeOutcome(String(insertedId), "pay_influencer", {
        resolvedBy: "admin",
        note: "checked",
      });
      expect(result).toMatchObject({ skipped: true });
      expect(tx.find).not.toHaveBeenCalled();
      expect(tx.updateMany).not.toHaveBeenCalled();
      expect(((await Invite.findById(insertedId).lean()) as any).status).toBe("withdrawn");
    });
  });

  describe("one bank transfer pays once (UTR)", () => {
    it("host pays creators 1+2 in one transfer, then creators 3 and 4 one by one", async () => {
      const [c1, c2, c3, c4] = [1, 2, 3, 4].map(() => new Types.ObjectId());
      const service = Object.create(PaymentsPayoutsService.prototype);
      Object.assign(service, { transactionModel: Tx, connection: db.conn });
      const check = (utr: string, invites: Types.ObjectId[]) =>
        (service as any).assertUtrNotUsedElsewhere(utr, { acceptedInviteIds: invites.map(String) });
      const save = (utr: string, invite: Types.ObjectId, batch: string) =>
        Tx.collection.insertOne({
          ...txBase(), inviteId: invite, utrNumber: utr, paymentBatchId: batch, collectionStatus: "proof_submitted",
        });

      // 1) Creators 1 and 2 accepted; one transfer (UTR A) covers both.
      await expect(check("UTRA0001", [c1, c2])).resolves.toBeUndefined();
      await save("UTRA0001", c1, "batch1");
      await save("UTRA0001", c2, "batch1");
      // Re-sending UTR A for the same two (e.g. a clearer screenshot) is fine.
      await expect(check("UTRA0001", [c1, c2])).resolves.toBeUndefined();

      // 2) Creator 3 accepts and is paid with a new transfer (UTR B).
      await expect(check("UTRB0002", [c3])).resolves.toBeUndefined();
      await save("UTRB0002", c3, "batch2");

      // 3) Creator 4 paid with its own transfer (UTR C) — fine; reusing A or B is refused.
      await expect(check("UTRA0001", [c4])).rejects.toThrow(/already used/);
      await expect(check("UTRB0002", [c4])).rejects.toThrow(/already used/);
      await expect(check("UTRC0003", [c4])).resolves.toBeUndefined();
    });

    const check = (calc: any) => {
      const service = Object.create(PaymentsPayoutsService.prototype);
      Object.assign(service, { transactionModel: Tx, connection: db.conn });
      return (service as any).assertUtrNotUsedElsewhere("4321 8765 1234", calc);
    };

    it("refuses a UTR already sent for other creators or a Premium payment; allows re-sending for the same rows", async () => {
      const invA = new Types.ObjectId();
      const invB = new Types.ObjectId();
      await Tx.collection.insertOne({
        ...txBase(), inviteId: invA, utrNumber: "432187651234", collectionStatus: "proof_submitted",
      });
      // Same creator's row again (fixing the screenshot): fine.
      await expect(check({ acceptedInviteIds: [String(invA)] })).resolves.toBeUndefined();
      // Another creator (or campaign) with the same transfer: refused, spaces or not.
      await expect(check({ acceptedInviteIds: [String(invB)] })).rejects.toThrow(/already used/);

      await Tx.collection.updateMany({ utrNumber: "432187651234" }, { $set: { collectionStatus: "failed" } });
      await expect(check({ acceptedInviteIds: [String(invB)] })).resolves.toBeUndefined(); // rejected proof frees it

      await db.conn.collection("payments").insertOne({ transactionId: "432187651234" });
      await expect(check({ acceptedInviteIds: [String(invB)] })).rejects.toThrow(/already used/);
    });
  });

  describe("pending-user cleanup (3 AM, when switched on)", () => {
    it("leaves recently restored accounts and anyone with collaboration history alone", async () => {
      const Inf = db.conn.models.Influencer || db.conn.model("Influencer", InfluencerSchema, "influencers");
      const old = new Date(Date.now() - 100 * 24 * 3600e3);
      const base = { status: "pending", isEmailVerified: false, firstRegisteredAt: old, createdAt: old, email: "", phoneNumber: "x" };
      const stale = new Types.ObjectId();
      const restored = new Types.ObjectId();
      const collaborated = new Types.ObjectId();
      await Inf.collection.insertMany([
        { _id: stale, ...base, email: "a@x.in", username: "u-a" },
        { _id: restored, ...base, email: "b@x.in", username: "u-b", restoredAt: new Date() },
        { _id: collaborated, ...base, email: "c@x.in", username: "u-c", status: "declined" },
      ]);
      await Invite.collection.insertOne({ campaignId: "camp-old", brandId: "b", influencerId: collaborated, status: "completed" });
      const empty = { find: () => ({ select: () => ({ lean: async () => [] }) }), updateMany: async () => ({}) };
      const service = Object.create(PendingUserCleanupService.prototype);
      Object.assign(service, {
        influencerModel: Inf,
        brandModel: empty,
        photographerModel: empty,
        paymentModel: { distinct: async () => [] },
        appSettingsModel: {
          findOne: () => ({ lean: async () => ({ pendingUserAutoDeleteEnabled: true, pendingUserAutoDeleteDays: 45 }) }),
          findOneAndUpdate: async () => ({}),
        },
        logger: { log: () => undefined },
      });
      await service.runCleanupNow("test");
      const status = async (id: Types.ObjectId) => ((await Inf.findById(id).lean()) as any).status;
      expect(await status(stale)).toBe("deleted");
      expect(await status(restored)).toBe("pending");
      expect(await status(collaborated)).toBe("declined");
    });
  });

  describe("deleted-account media purge (2 AM)", () => {
    it("removes gallery media but never changes the status (a pending self-delete still gets anonymized)", async () => {
      const Inf = db.conn.models.Influencer || db.conn.model("Influencer", InfluencerSchema, "influencers");
      const id = new Types.ObjectId();
      await Inf.collection.insertOne({
        _id: id, email: "p@x.in", username: "u-p", phoneNumber: "x", status: "deletion_pending", isDeleted: true,
        deletedAt: new Date(Date.now() - 60 * 24 * 3600e3),
        profileImages: [{ public_id: "keep" }, { public_id: "gone" }],
      });
      const deleted: string[] = [];
      const empty = { find: () => ({ lean: async () => [] }) };
      const service = Object.create(ImageCleanupService.prototype);
      Object.assign(service, {
        influencerModel: Inf,
        brandModel: empty,
        photographerModel: empty,
        cloudinaryService: { deleteImage: async (pid: string) => deleted.push(pid) },
        logger: { log: () => undefined, warn: () => undefined },
      });
      await service.cleanupSoftDeletedUsers(45);
      const after: any = await Inf.findById(id).lean();
      expect(after.status).toBe("deletion_pending");
      expect(after.profileImages.map((i: any) => i.public_id)).toEqual(["keep"]);
      expect(deleted).toEqual(["gone"]);
    });
  });

  describe("Early Access (0% commission) auto-assignment", () => {
    it("is once per account: an expired member isn't picked again, a newcomer is", async () => {
      const Inf = db.conn.models.Influencer || db.conn.model("Influencer", InfluencerSchema, "influencers");
      const Brand = db.conn.models.Brand || db.conn.model("Brand", BrandSchema, "brands");
      const day = 24 * 3600e3;
      const veteran = new Types.ObjectId();
      const newcomer = new Types.ObjectId();
      await Inf.collection.insertMany([
        {
          _id: veteran, email: "v@x.in", username: "u-v", phoneNumber: "1", status: "accepted", isEmailVerified: true,
          createdAt: new Date(Date.now() - 400 * day), commissionBadge: "early_access_creator", adminTags: ["Early Access"],
          commissionOverride: {
            enabled: true, overrideType: "fixed", value: 0, source: "early_access_program",
            assignedAt: new Date(Date.now() - 40 * day), validUntil: new Date(Date.now() - 10 * day),
          },
        },
        { _id: newcomer, email: "n@x.in", username: "u-n", phoneNumber: "2", status: "accepted", isEmailVerified: true, createdAt: new Date(Date.now() - day) },
      ]);
      const service = new EarlyAccessAssignmentService(
        Inf as any,
        Brand as any,
        {
          findOne: () => ({ lean: async () => ({ earlyAccessAssignmentMode: "auto" }) }),
          findOneAndUpdate: () => ({ lean: async () => ({}) }),
        } as any,
      );
      await service.autoAssignEarlyAccess("test");
      const v: any = await Inf.findById(veteran).lean();
      const n: any = await Inf.findById(newcomer).lean();
      expect(v.commissionOverride.enabled).toBe(false); // released, not re-assigned
      expect(v.earlyAccessGrantedAt).toBeTruthy();
      expect(n.commissionOverride.enabled).toBe(true);
      expect(n.commissionBadge).toBe("early_access_creator");
    });
  });

  describe("a payment that lands after the collaboration closed", () => {
    it("is recorded, unlocks nothing, and is marked as a refund owed to the host", async () => {
      const { insertedId: inviteId } = await Invite.collection.insertOne({
        campaignId: "camp-late-pay", brandId: "b", influencerId: new Types.ObjectId(),
        status: "withdrawn", unlocked: false,
      });
      const { insertedId: txId } = await Tx.collection.insertOne({
        ...txBase(), inviteId, collectionStatus: "proof_submitted", payoutStatus: "pending", gateway: "manual_upi",
      });
      const service = Object.create(PaymentsPayoutsService.prototype);
      Object.assign(service, {
        transactionModel: Tx,
        inviteModel: Invite,
        connection: db.conn,
        recordPaymentCompleted: async () => undefined,
        recordCampaignPaymentConversion: async () => undefined,
        // Host email after verifying (best-effort, not under test).
        brandModel: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
        pushService: { sendToUser: async () => undefined },
        notificationsService: { createForUser: async () => undefined },
      });
      await service.verifyCollectionById(String(txId), "UTR checked");
      const tx: any = await Tx.findById(txId).lean();
      const invite: any = await Invite.findById(inviteId).lean();
      expect(tx.collectionStatus).toBe("verified");
      expect(tx.refundStatus).toBe("owed");
      expect(invite.unlocked).toBe(false);
      expect(invite.status).toBe("withdrawn");
    });
  });
});
