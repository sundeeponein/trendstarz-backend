import {
  Body,
  Controller,
  Get,
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

  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/calculate")
  async calculate(@Param("campaignId") campaignId: string, @Req() req: any) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.calculatePayment(campaignId, payerId);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } }) // max 5 UTR submissions per minute per IP
  @UseGuards(JwtAuthGuard)
  @Post(":campaignId/submit-proof")
  async submitProof(
    @Param("campaignId") campaignId: string,
    @Req() req: any,
    @Body() body: { utrNumber: string; paymentProofUrl?: string },
  ) {
    const payerId = req.user?.userId;
    return this.paymentsPayoutsService.submitPaymentProof(
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("summary")
  async summary() {
    return this.paymentsPayoutsService.getAdminSummary();
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
