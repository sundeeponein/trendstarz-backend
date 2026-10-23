import { Types } from "mongoose";
import { PaymentsPayoutsService } from "./payments-payouts.service";
import { PaymentController } from "../payment/payment.controller";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("payment parties (real MongoDB)", () => {
  let db: TestDb;
  let Tx: any;
  const host = new Types.ObjectId().toHexString();
  const creator = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    db = await startTestDb();
    const { Schema } = require("mongoose");
    Tx = db.conn.model("TxParties", new Schema({}, { strict: false }), "campaigntransactions");
  });
  afterAll(async () => db?.stop());

  const ctx = () => ({
    transactionModel: Tx,
    pushService: { sendToUser: jest.fn().mockResolvedValue(undefined) },
    notificationsService: { createForUser: jest.fn().mockResolvedValue(undefined) },
  });
  const raise = (c: any, txId: string, who: string, role: string) =>
    (PaymentsPayoutsService.prototype as any).raiseDispute.call(c, txId, who, role, "not delivered");

  it("a photographer hosting their own campaign can dispute as the payer; the creator is notified", async () => {
    const tx = await Tx.create({ payerId: host, payerRole: "photographer", recipientId: creator, recipientRole: "influencer", payoutStatus: "pending" });
    const c = ctx();
    const res = await raise(c, String(tx._id), host, "photographer");
    expect(res.transaction.disputeStatus).toBe("open");
    expect(c.notificationsService.createForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: creator, userRole: "influencer" }));
  });

  it("the creator's dispute notifies the host with the host's real role", async () => {
    const tx = await Tx.create({ payerId: host, payerRole: "photographer", recipientId: creator, recipientRole: "influencer", payoutStatus: "pending" });
    const c = ctx();
    await raise(c, String(tx._id), creator, "influencer");
    expect(c.notificationsService.createForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: host, userRole: "photographer" }));
  });

  it("someone outside the transaction can't dispute it", async () => {
    const tx = await Tx.create({ payerId: host, recipientId: creator, payoutStatus: "pending" });
    await expect(raise(ctx(), String(tx._id), new Types.ObjectId().toHexString(), "brand")).rejects.toThrow("not a party");
  });

  it("a Premium payment can be read only by its payer or an admin", async () => {
    const payer = new Types.ObjectId();
    const service = { getPaymentById: async () => ({ success: true, payment: { _id: "p1", userId: { _id: payer, email: "x@y.in" } } }) };
    const controller = new (PaymentController as any)(service);
    const req = (userId: string, role = "brand") => ({ user: { userId, role } });
    await expect(controller.getPaymentById("p1", req(String(payer)))).resolves.toMatchObject({ success: true });
    await expect(controller.getPaymentById("p1", req("someone", "admin"))).resolves.toMatchObject({ success: true });
    await expect(controller.getPaymentById("p1", req("someone"))).rejects.toThrow("Payment not found");
  });
});
