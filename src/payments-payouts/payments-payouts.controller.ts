import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PaymentsPayoutsService } from "./payments-payouts.service";

@Controller("campaign-transactions")
export class PaymentsPayoutsController {
  constructor(
    private readonly paymentsPayoutsService: PaymentsPayoutsService,
  ) {}

  @Post("webhooks/razorpayx")
  async handleRazorpayXWebhook(
    @Req() req: any,
    @Headers("x-razorpay-signature") signature: string,
  ) {
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));
    return this.paymentsPayoutsService.handleRazorpayXWebhook(
      rawBody,
      String(signature || ""),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/calculate")
  async calculate(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body() body: { inviteIds?: string[] },
  ) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.calculatePayment(
      campaignId,
      payerId,
      inviteIdList(body?.inviteIds),
    );
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } }) // max 5 UTR submissions per minute per IP
  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/submit-proof")
  async submitProof(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body()
    body: {
      utrNumber: string;
      paymentProofUrl?: string;
      acceptTerms?: boolean;
      inviteIds?: string[];
    },
  ) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.submitPaymentProof(campaignId, payerId, {
      ...body,
      inviteIds: inviteIdList(body?.inviteIds),
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/razorpay/order")
  async createRazorpayOrder(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body() body: { acceptTerms?: boolean; inviteIds?: string[] },
  ) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.createRazorpayOrderForCampaign(
      campaignId,
      payerId,
      body?.acceptTerms,
      inviteIdList(body?.inviteIds),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/razorpay/verify")
  async verifyRazorpayPayment(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body() body: { orderId: string; paymentId: string; signature: string },
  ) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.verifyRazorpayCampaignPayment(
      campaignId,
      payerId,
      body,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  async list(@Query("status") status?: string) {
    return this.paymentsPayoutsService.listForAdmin(status);
  }

  /**
   * GET /campaign-transactions/summary
   * GET /campaign-transactions/summary?days=7 — restrict to the last N days (e.g. dashboard widgets)
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("summary")
  async summary(@Query("days") days?: string) {
    const parsedDays = Number(days);
    const since =
      Number.isFinite(parsedDays) && parsedDays > 0
        ? new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000)
        : undefined;
    return this.paymentsPayoutsService.getAdminSummary(since);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/gateway-readiness")
  async gatewayReadiness() {
    return this.paymentsPayoutsService.getGatewayReadiness();
  }

  /** Admin: confirm one whole payment (every creator it covered) in one step. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("batch/:batchId/verify")
  async verifyBatch(
    @Param("batchId") batchId: string,
    @Body() body: { notes?: string },
  ) {
    return this.paymentsPayoutsService.verifyCollectionBatch(batchId, body?.notes);
  }

  /** Admin: reject one whole payment (its UTR/proof covers every creator in it). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("batch/:batchId/reject")
  async rejectBatch(
    @Param("batchId") batchId: string,
    @Body() body: { reason: string },
  ) {
    return this.paymentsPayoutsService.rejectCollectionBatch(batchId, body?.reason);
  }

  /** Admin: return a no-show creator's platform fee to the host as TrendStarZ credit. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/refund-fee-credit")
  async refundFeeCredit(@Param("id") id: string, @Req() req: any) {
    return this.paymentsPayoutsService.refundPlatformFeeAsCredit(
      id,
      String(req.user?.userId || ""),
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/verify")
  async verify(@Param("id") id: string, @Body() body: { notes?: string }) {
    return this.paymentsPayoutsService.verifyCollection(id, body?.notes);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/reject")
  async reject(@Param("id") id: string, @Body() body: { reason: string }) {
    return this.paymentsPayoutsService.rejectCollection(id, body?.reason);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/mark-paid")
  async markPaid(
    @Param("id") id: string,
    @Body()
    body: {
      payoutUtr: string;
      payoutProofUrl?: string;
      payoutUpiId?: string;
      notes?: string;
    },
  ) {
    return this.paymentsPayoutsService.markPayoutPaid(id, body);
  }

  /** Admin Refunds queue — ?state=on_hold|owed|sent|settlement|legacy_unconfirmed */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/refunds")
  async listRefunds(@Query("state") state?: string) {
    return this.paymentsPayoutsService.listRefunds(state);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/mark-refund-sent")
  async markRefundSent(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: {
      refundUtr: string;
      refundAmount?: number;
      transferDate?: string;
      notes?: string;
    },
  ) {
    return this.paymentsPayoutsService.markRefundSent(
      id,
      req.user?.userId,
      body,
    );
  }

  /** Admin issues a fee credit that was parked for review. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/fee-credit/approve")
  async approveFeeCredit(@Param("id") id: string, @Req() req: any) {
    return this.paymentsPayoutsService.approveFeeCredit(id, req.user?.userId);
  }

  /** Admin withholds a fee credit that was parked for review (reason required). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/fee-credit/withhold")
  async withholdFeeCredit(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reason?: string },
  ) {
    return this.paymentsPayoutsService.withholdFeeCredit(
      id,
      req.user?.userId,
      body?.reason,
    );
  }

  /** Admin: an owner's TrendStarZ credit balance and ledger. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("admin/credit/:ownerId")
  async adminCredit(@Param("ownerId") ownerId: string) {
    return this.paymentsPayoutsService.adminCredit(ownerId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/settlement/host-repaid")
  async recordHostRepayment(
    @Param("id") id: string,
    @Req() req: any,
    @Body()
    body: { utr?: string; amount?: number; repaidAt?: string; notes?: string },
  ) {
    return this.paymentsPayoutsService.recordHostRepayment(
      id,
      req.user?.userId,
      body || {},
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/settlement/exception")
  async approveSettlementException(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body: { reason?: string },
  ) {
    return this.paymentsPayoutsService.approveSettlementException(
      id,
      req.user?.userId,
      body || {},
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/auto-payout/run")
  async runAutoPayout(@Req() req: any) {
    return this.paymentsPayoutsService.runAutoPayoutSweep(req.user?.userId);
  }

  /** The signed-in host's TrendStarZ credit balance and ledger. */
  @UseGuards(JwtAuthGuard)
  @Get("my/credit")
  async myCredit(@Req() req: any) {
    return this.paymentsPayoutsService.myCredit(req.user?.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get("my/history")
  async myHistory(@Req() req: any) {
    const userId = req.user?.userId;
    const role = req.user?.role;
    return this.paymentsPayoutsService.listMine(userId, role);
  }

  // ── Campaign-level status (brand polls after submitting payment) ──────────

  @UseGuards(JwtAuthGuard)
  @Get("campaign/:campaignId/status")
  async campaignStatus(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
  ) {
    return this.paymentsPayoutsService.getForCampaign(
      campaignId,
      req.user?.userId,
    );
  }

  // ── Dispute endpoints ─────────────────────────────────────────────────────

  /** Brand or influencer raises a payment dispute → payment is frozen. */
  @Throttle({ default: { ttl: 60000, limit: 5 } }) // max 5 disputes per minute per IP
  @UseGuards(JwtAuthGuard)
  @Post(":id/raise-dispute")
  async raiseDispute(
    @Param("id") id: string,
    @Body() body: { reason: string },
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    const normalizedRole = String(req.user?.role || "").toLowerCase();
    const role =
      normalizedRole === "brand"
        ? "brand"
        : normalizedRole === "photographer"
          ? "photographer"
          : "influencer";
    return this.paymentsPayoutsService.raiseDispute(id, userId, role, body.reason);
  }

  /** Admin resolves a frozen dispute and decides payment direction. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(":id/resolve-dispute")
  async resolveDispute(
    @Param("id") id: string,
    @Body()
    body: {
      outcome: "release_to_influencer" | "refund_to_brand";
      notes?: string;
    },
    @Req() req: any,
  ) {
    return this.paymentsPayoutsService.resolveDispute(
      id,
      req.user?.userId,
      body.outcome,
      body.notes,
    );
  }

  /** Admin — list all open (frozen) disputes. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("disputes/open")
  async openDisputes() {
    return this.paymentsPayoutsService.listOpenDisputes();
  }
}

/** Invite ids from a request body: strings only, deduplicated; undefined = all. */
function inviteIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.map((v) => String(v ?? "").trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
}
