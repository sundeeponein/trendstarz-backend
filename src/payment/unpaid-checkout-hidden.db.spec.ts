import { Types } from "mongoose";
import { PaymentService } from "./payment.service";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { BrandSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("unpaid Razorpay checkouts are not admin-approvable payments (real MongoDB)", () => {
  let db: TestDb;
  let Payment: any;
  let service: any;
  const user = new Types.ObjectId();

  beforeAll(async () => {
    db = await startTestDb();
    Payment = db.conn.model("PaymentUnpaid", PaymentSchema, "payments");
    if (!db.conn.models.Brand) db.conn.model("Brand", BrandSchema, "brands");
    service = Object.assign(Object.create(PaymentService.prototype), { paymentModel: Payment });
  });
  afterAll(async () => db?.stop());

  it("hides them from the pending list and refuses to approve them; manual UPI still works", async () => {
    const checkout = await Payment.create({ userId: user, userType: "Brand", transactionId: "rzp_1", amount: 49900, amountPaise: 49900, premiumDuration: "1m", status: "pending", paymentMethod: "razorpay", gatewayProvider: "razorpay", purpose: "subscription", orderId: "order_1" });
    const upi = await Payment.create({ userId: user, userType: "Brand", transactionId: "UTR123", amount: 499, amountPaise: 49900, premiumDuration: "1m", status: "pending", paymentMethod: "upi", purpose: "subscription" });

    const listed = await service.getPendingPayments(1, 10);
    const ids = (listed.payments || listed.data || []).map((p: any) => String(p._id));
    expect(ids).toEqual([String(upi._id)]);

    const res = await service.approvePayment(String(checkout._id), String(new Types.ObjectId()));
    expect(res.success).toBe(false);
    expect(((await Payment.findById(checkout._id).lean()) as any).status).toBe("pending");
  });
});
