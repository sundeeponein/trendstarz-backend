const items = [
  { id: "pay_ok", order_id: "order_ok", status: "captured", amount: 49900, created_at: 1790000000, email: "a@x.in" },
  { id: "pay_lost", order_id: "order_lost", status: "captured", amount: 60000, created_at: 1790000100, email: "b@x.in" },
  { id: "pay_camp", order_id: "order_camp", status: "captured", amount: 100000, created_at: 1790000200, email: "c@x.in" },
  { id: "pay_unknown", order_id: "order_other", status: "captured", amount: 100, created_at: 1790000300, email: "d@x.in" },
  { id: "pay_failed", order_id: "order_failed", status: "failed", amount: 100, created_at: 1790000400, email: "e@x.in" },
];
jest.mock("razorpay", () => jest.fn().mockImplementation(() => ({ payments: { all: jest.fn().mockResolvedValue({ items }) } })));

import { reconcileRazorpay } from "./razorpay-reconcile";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("Razorpay reconciliation (real MongoDB)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_KEY_SECRET = "s";
  });
  afterAll(async () => db?.stop());

  it("flags captured money that TrendStarZ never completed, and orders it doesn't know", async () => {
    const raw: any = db.conn.db;
    await raw.collection("payments").insertMany([
      { orderId: "order_ok", status: "approved", purpose: "subscription" },
      { orderId: "order_lost", status: "pending", purpose: "subscription" },
    ]);
    await raw.collection("campaigntransactions").insertOne({ gatewayOrderId: "order_camp", collectionStatus: "awaiting_payment" });

    const r = await reconcileRazorpay(raw, 7);
    expect(r.checked).toBe(4); // the failed payment is ignored
    expect(r.recorded).toBe(1);
    expect(r.notRecorded.map((x) => x.paymentId).sort()).toEqual(["pay_camp", "pay_lost"]);
    expect(r.notRecorded.find((x) => x.paymentId === "pay_lost")).toMatchObject({ amountRupees: 600, record: 'subscription is "pending"' });
    expect(r.unknownOrder.map((x) => x.paymentId)).toEqual(["pay_unknown"]);
  });
});
