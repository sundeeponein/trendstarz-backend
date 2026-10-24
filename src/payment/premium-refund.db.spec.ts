import { Types } from "mongoose";
import { PaymentService } from "./payment.service";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { SubscriptionSchema } from "../database/schemas/plan.schema";
import { BrandSchema } from "../database/schemas/profile.schemas";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

const DAY = 86400000;

describe("refunding a Premium payment takes back only what it bought (real MongoDB)", () => {
  let db: TestDb;
  let Payment: any, Sub: any, Brand: any, service: any;

  beforeAll(async () => {
    db = await startTestDb();
    Payment = db.conn.model("PaymentRefund", PaymentSchema, "payments");
    Sub = db.conn.model("SubRefund", SubscriptionSchema, "subscriptions");
    Brand = db.conn.models.Brand || db.conn.model("Brand", BrandSchema, "brands");
    service = Object.assign(Object.create(PaymentService.prototype), {
      paymentModel: Payment,
      brandModel: Brand,
      plansService: { subscriptionModel: Sub },
      pushService: { sendToUser: jest.fn().mockResolvedValue(undefined) },
      notificationsService: { createForUser: jest.fn().mockResolvedValue(undefined) },
    });
  });
  afterAll(async () => db?.stop());

  async function setup(subEndDays: number, source: "payment" | "admin") {
    const brand: any = await Brand.create({ brandName: "B" + Math.random(), brandUsername: "b" + Date.now() + Math.random(), email: `b${Math.random()}@x.in`, phoneNumber: String(Math.floor(Math.random() * 1e10)), password: "h", isPremium: true, premiumEnd: new Date(Date.now() + subEndDays * DAY) });
    await Sub.create({ userId: brand._id, userType: "BRAND", planId: new Types.ObjectId(), planCode: "pro", planName: "Pro", priceSnapshot: 499, status: "active", source, billingCycle: "monthly", startDate: new Date(), endDate: new Date(Date.now() + subEndDays * DAY) });
    const pay = await Payment.create({ userId: brand._id, userType: "Brand", transactionId: "T" + Math.random(), amount: 49900, amountPaise: 49900, premiumDuration: "1m", status: "approved", paymentMethod: "razorpay", purpose: "subscription" });
    return { brand, pay };
  }

  it("a stacked renewal is shortened by one month, Premium stays until the new end", async () => {
    const { brand, pay } = await setup(60, "payment");
    const res = await service.refundPayment(String(pay._id), String(new Types.ObjectId()), "duplicate renewal");
    expect(res.success).toBe(true);
    const sub: any = await Sub.findOne({ userId: brand._id }).lean();
    expect(sub.status).toBe("active");
    const leftDays = (new Date(sub.endDate).getTime() - Date.now()) / DAY;
    expect(leftDays).toBeGreaterThan(25);
    expect(leftDays).toBeLessThan(35);
    const b: any = await Brand.findById(brand._id).lean();
    expect(b.isPremium).toBe(true);
    expect(new Date(b.premiumEnd).getTime()).toBe(new Date(sub.endDate).getTime());
  });

  it("a single paid month is removed completely", async () => {
    const { brand, pay } = await setup(20, "payment");
    await service.refundPayment(String(pay._id), String(new Types.ObjectId()), "refund");
    expect(((await Sub.findOne({ userId: brand._id }).lean()) as any).status).toBe("cancelled");
    expect(((await Brand.findById(brand._id).lean()) as any).isPremium).toBe(false);
  });

  it("an admin-granted subscription is left alone and the profile stays Premium", async () => {
    const { brand, pay } = await setup(40, "admin");
    await service.refundPayment(String(pay._id), String(new Types.ObjectId()), "refund");
    expect(((await Sub.findOne({ userId: brand._id }).lean()) as any).status).toBe("active");
    expect(((await Brand.findById(brand._id).lean()) as any).isPremium).toBe(true);
  });
});
