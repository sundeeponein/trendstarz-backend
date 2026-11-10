import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Types } from "mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { LogAdminAction } from "../utils/admin-action.interceptor";
import { PriceChangesService } from "./price-changes.service";

/** Admin: a creator's price history and the approval of big price jumps. */
@Controller("admin/price-changes")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminPriceChangesController {
  constructor(private readonly priceChanges: PriceChangesService) {}

  @Get("user/:userId")
  async forUser(@Param("userId") userId: string) {
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException("Invalid user id");
    return this.priceChanges.listForUser(userId);
  }

  @Post(":id/approve")
  @LogAdminAction("price_change_approve")
  async approve(@Param("id") id: string, @Req() req: any) {
    return this.priceChanges.approve(id, String(req?.user?.userId || ""));
  }

  @Post(":id/reject")
  @LogAdminAction("price_change_reject")
  async reject(@Param("id") id: string, @Req() req: any, @Body() body: { note?: string }) {
    return this.priceChanges.reject(id, String(req?.user?.userId || ""), body?.note);
  }
}

/** Creator: their own prices waiting for approval. */
@Controller("creator/rates")
@UseGuards(JwtAuthGuard)
export class CreatorPendingPricesController {
  constructor(private readonly priceChanges: PriceChangesService) {}

  @Get("pending")
  async pending(@Req() req: any) {
    const role = String(req?.user?.role || "").toLowerCase();
    if (role !== "influencer" && role !== "photographer") return [];
    return this.priceChanges.pendingForUser(String(req?.user?.userId || ""));
  }
}
