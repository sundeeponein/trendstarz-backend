import { Types } from "mongoose";
import { PaymentsPayoutsService } from "./payments-payouts.service";
import { CampaignTransactionSchema } from "../database/schemas/campaign-transaction.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("admin confirms no post: refund on hold becomes owed now (real MongoDB)", () => {
  let db: TestDb;
  let Tx: any;
  const openReports = new Set<string>();
  let service: any;

  beforeAll(async () => {
    db = await startTestDb();
    Tx = db.conn.model("CampaignTransaction", CampaignTransactionSchema, "campaigntransactions");
    service = Object.assign(Object.create(PaymentsPayoutsService.prototype), {
      transactionModel: Tx,
      hasOpenReport: async (inviteId: any) => openReports.has(String(inviteId)),
      setFinancialCaseOpen: jest.fn(async () => undefined),
    });
  });
  afterAll(() => db.stop());

  const held = async (over: Record<string, any> = {}) => {
    const { insertedId } = await Tx.collection.insertOne({
      transactionType: "paid_collab",
      campaignId: new Types.ObjectId().toHexString(),
      inviteId: new Types.ObjectId(),
      payerId: "p",
      recipientId: "r",
      collectionStatus: "verified",
      payoutStatus: "skipped",
      refundStatus: "on_hold",
      refundHoldUntil: new Date(Date.now() + 2 * 86400000),
      payerTotal: 60000,
      ...over,
    });
    return String(insertedId);
  };

  it("moves the refund to owed with the admin's reason in the history", async () => {
    const id = await held();
    await expect(service.approveRefundNow(id, "admin-1", "Checked the handle — no reel posted")).resolves.toMatchObject({ refundStatus: "owed" });
    const tx: any = await Tx.findById(id).lean();
    expect(tx).toMatchObject({ refundStatus: "owed", refundOwedBy: "admin-1" });
    expect(tx.refundHistory.at(-1)).toMatchObject({ action: "refund_approved_early", byRole: "admin", from: "on_hold", to: "owed" });
    expect(service.setFinancialCaseOpen).toHaveBeenCalled();
  });

  it("refuses without a reason, with a late post waiting, with an open report, or when not on hold", async () => {
    await expect(service.approveRefundNow(await held(), "a", "short")).rejects.toThrow(/Write what you checked/);
    await expect(service.approveRefundNow(await held({ latePost: { status: "pending" } }), "a", "no post found at all")).rejects.toThrow(/late post/);
    const reported = new Types.ObjectId();
    openReports.add(String(reported));
    await expect(service.approveRefundNow(await held({ inviteId: reported }), "a", "no post found at all")).rejects.toThrow(/open report/);
    await expect(service.approveRefundNow(await held({ refundStatus: "owed" }), "a", "no post found at all")).rejects.toThrow(/Only a refund on hold/);
  });
});
