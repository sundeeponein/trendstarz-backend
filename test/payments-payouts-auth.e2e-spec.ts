import { BadRequestException, INestApplication, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import request from "supertest";
import { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
import { RolesGuard } from "../src/auth/roles.guard";
import { PaymentsPayoutsController } from "../src/payments-payouts/payments-payouts.controller";
import { PaymentsPayoutsService } from "../src/payments-payouts/payments-payouts.service";

const TEST_JWT_SECRET = "e2e-test-jwt-secret-min-32-characters";
process.env.JWT_SECRET = TEST_JWT_SECRET;

describe("PaymentsPayouts guards (e2e)", () => {
  let app: INestApplication;

  const serviceMock: Partial<jest.Mocked<PaymentsPayoutsService>> = {
    getAdminSummary: jest.fn().mockResolvedValue({ success: true, data: {} }),
    listForAdmin: jest.fn().mockResolvedValue({ success: true, data: [] }),
    listMine: jest.fn().mockResolvedValue({ success: true, data: [] }),
    calculatePayment: jest.fn().mockResolvedValue({ success: true }),
    submitPaymentProof: jest.fn().mockResolvedValue({ success: true }),
    verifyCollection: jest.fn().mockResolvedValue({ success: true }),
    rejectCollection: jest.fn().mockResolvedValue({ success: true }),
    markPayoutPaid: jest.fn().mockResolvedValue({ success: true }),
  };

  const adminToken = jwt.sign(
    { userId: "admin1", role: "admin" },
    TEST_JWT_SECRET,
  );
  const brandToken = jwt.sign(
    { userId: "brand1", role: "brand" },
    TEST_JWT_SECRET,
  );
  const influencerToken = jwt.sign(
    { userId: "inf1", role: "influencer" },
    TEST_JWT_SECRET,
  );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsPayoutsController],
      providers: [
        JwtAuthGuard,
        RolesGuard,
        {
          provide: PaymentsPayoutsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /campaign-transactions/summary returns 401 without token", () => {
    return request(app.getHttpServer()).get("/campaign-transactions/summary").expect(401);
  });

  it("GET /campaign-transactions/summary returns 403 for non-admin", () => {
    return request(app.getHttpServer())
      .get("/campaign-transactions/summary")
      .set("Authorization", `Bearer ${brandToken}`)
      .expect(403);
  });

  it("GET /campaign-transactions/summary returns 200 for admin", () => {
    return request(app.getHttpServer())
      .get("/campaign-transactions/summary")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200)
      .expect({ success: true, data: {} });
  });

  it("GET /campaign-transactions/my/history returns 401 without token", () => {
    return request(app.getHttpServer()).get("/campaign-transactions/my/history").expect(401);
  });

  it("GET /campaign-transactions/my/history returns 200 for authenticated non-admin", () => {
    return request(app.getHttpServer())
      .get("/campaign-transactions/my/history")
      .set("Authorization", `Bearer ${brandToken}`)
      .expect(200)
      .expect({ success: true, data: [] });
  });

  it("GET /campaign-transactions/my/history forwards userId and role from JWT", async () => {
    await request(app.getHttpServer())
      .get("/campaign-transactions/my/history")
      .set("Authorization", `Bearer ${influencerToken}`)
      .expect(200)
      .expect({ success: true, data: [] });

    expect(serviceMock.listMine).toHaveBeenCalledWith("inf1", "influencer");
  });

  it("POST /campaign-transactions/:campaignId/calculate returns 401 without token", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/camp1/calculate")
      .expect(401);
  });

  it("POST /campaign-transactions/:campaignId/calculate returns 201 and forwards campaignId + payerId", async () => {
    await request(app.getHttpServer())
      .post("/campaign-transactions/camp1/calculate")
      .set("Authorization", `Bearer ${brandToken}`)
      .expect(201)
      .expect({ success: true });

    expect(serviceMock.calculatePayment).toHaveBeenCalledWith("camp1", "brand1");
  });

  it("POST /campaign-transactions/:campaignId/calculate returns 404 when service throws not found", async () => {
    (serviceMock.calculatePayment as jest.Mock).mockRejectedValueOnce(
      new NotFoundException("Campaign not found"),
    );

    const res = await request(app.getHttpServer())
      .post("/campaign-transactions/missing-campaign/calculate")
      .set("Authorization", `Bearer ${brandToken}`)
      .expect(404);

    expect(res.body?.message).toBe("Campaign not found");
  });

  it("POST /campaign-transactions/:campaignId/submit-proof returns 401 without token", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/camp1/submit-proof")
      .send({ utrNumber: "UTR123" })
      .expect(401);
  });

  it("POST /campaign-transactions/:campaignId/submit-proof returns 201 and forwards full proof payload", async () => {
    const body = {
      utrNumber: "UTR123",
      paymentProofUrl: "https://proof-url",
    };

    await request(app.getHttpServer())
      .post("/campaign-transactions/camp1/submit-proof")
      .set("Authorization", `Bearer ${brandToken}`)
      .send(body)
      .expect(201)
      .expect({ success: true });

    expect(serviceMock.submitPaymentProof).toHaveBeenCalledWith(
      "camp1",
      "brand1",
      body,
    );
  });

  it("POST /campaign-transactions/:campaignId/submit-proof returns 400 when service throws bad request", async () => {
    (serviceMock.submitPaymentProof as jest.Mock).mockRejectedValueOnce(
      new BadRequestException("UTR number is required"),
    );

    const res = await request(app.getHttpServer())
      .post("/campaign-transactions/camp1/submit-proof")
      .set("Authorization", `Bearer ${brandToken}`)
      .send({ utrNumber: "" })
      .expect(400);

    expect(res.body?.message).toBe("UTR number is required");
  });

  it("POST /campaign-transactions/:id/verify returns 401 without token", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/verify")
      .send({ notes: "ok" })
      .expect(401);
  });

  it("POST /campaign-transactions/:id/verify returns 403 for non-admin", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/verify")
      .set("Authorization", `Bearer ${brandToken}`)
      .send({ notes: "ok" })
      .expect(403);
  });

  it("POST /campaign-transactions/:id/verify returns 201 and forwards payload for admin", async () => {
    await request(app.getHttpServer())
      .post("/campaign-transactions/tx1/verify")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "ok" })
      .expect(201)
      .expect({ success: true });

    expect(serviceMock.verifyCollection).toHaveBeenCalledWith("tx1", "ok");
  });

  it("POST /campaign-transactions/:id/verify returns 404 when service throws not found", async () => {
    (serviceMock.verifyCollection as jest.Mock).mockRejectedValueOnce(
      new NotFoundException("Transaction not found"),
    );

    const res = await request(app.getHttpServer())
      .post("/campaign-transactions/missing-tx/verify")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "ok" })
      .expect(404);

    expect(res.body?.message).toBe("Transaction not found");
  });

  it("POST /campaign-transactions/:id/reject returns 401 without token", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/reject")
      .send({ reason: "invalid proof" })
      .expect(401);
  });

  it("POST /campaign-transactions/:id/reject returns 403 for non-admin", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/reject")
      .set("Authorization", `Bearer ${brandToken}`)
      .send({ reason: "invalid proof" })
      .expect(403);
  });

  it("POST /campaign-transactions/:id/reject returns 201 and forwards payload for admin", async () => {
    await request(app.getHttpServer())
      .post("/campaign-transactions/tx1/reject")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "invalid proof" })
      .expect(201)
      .expect({ success: true });

    expect(serviceMock.rejectCollection).toHaveBeenCalledWith(
      "tx1",
      "invalid proof",
    );
  });

  it("POST /campaign-transactions/:id/reject returns 400 when service throws bad request", async () => {
    (serviceMock.rejectCollection as jest.Mock).mockRejectedValueOnce(
      new BadRequestException("Reason is required"),
    );

    const res = await request(app.getHttpServer())
      .post("/campaign-transactions/tx1/reject")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "" })
      .expect(400);

    expect(res.body?.message).toBe("Reason is required");
  });

  it("POST /campaign-transactions/:id/mark-paid returns 401 without token", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/mark-paid")
      .send({ payoutUtr: "PAYOUT123" })
      .expect(401);
  });

  it("POST /campaign-transactions/:id/mark-paid returns 403 for non-admin", () => {
    return request(app.getHttpServer())
      .post("/campaign-transactions/tx1/mark-paid")
      .set("Authorization", `Bearer ${brandToken}`)
      .send({ payoutUtr: "PAYOUT123" })
      .expect(403);
  });

  it("POST /campaign-transactions/:id/mark-paid returns 201 and forwards full payload for admin", async () => {
    const payload = {
      payoutUtr: "PAYOUT123",
      payoutProofUrl: "https://proof",
      payoutUpiId: "user@upi",
      notes: "done",
    };

    await request(app.getHttpServer())
      .post("/campaign-transactions/tx1/mark-paid")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(201)
      .expect({ success: true });

    expect(serviceMock.markPayoutPaid).toHaveBeenCalledWith("tx1", payload);
  });

  it("POST /campaign-transactions/:id/mark-paid returns 400 when service throws bad request", async () => {
    (serviceMock.markPayoutPaid as jest.Mock).mockRejectedValueOnce(
      new BadRequestException("Collection must be verified before payout"),
    );

    const res = await request(app.getHttpServer())
      .post("/campaign-transactions/tx1/mark-paid")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ payoutUtr: "PAYOUT123" })
      .expect(400);

    expect(res.body?.message).toBe("Collection must be verified before payout");
  });
});
