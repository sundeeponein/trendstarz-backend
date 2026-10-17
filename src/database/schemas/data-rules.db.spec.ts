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
});
