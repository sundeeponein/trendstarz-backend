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
}
