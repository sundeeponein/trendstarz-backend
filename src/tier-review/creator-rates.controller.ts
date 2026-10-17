import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { isSocialAccountId } from "../utils/social-account.util";

const COLLECTION: Record<string, string> = {
  influencer: "influencers",
  photographer: "photographers",
};

/**
 * "These rates are still right": the creator confirms ALL rates on one of their
 * own accounts without changing them (sets each rate's priceConfirmedAt to now).
 * Needed after a tier change — saving an unchanged rate keeps its old date (3D-1d).
 */
@Controller("creator/rates")
@UseGuards(JwtAuthGuard)
export class CreatorRatesController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Post("confirm")
  async confirm(@Req() req: any, @Body() body: { socialAccountId?: string }) {
    const collection = COLLECTION[String(req?.user?.role || "").toLowerCase()];
    const userId = String(req?.user?.userId || "");
    const socialAccountId = body?.socialAccountId;
    if (!collection || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException("Only creators can confirm their rates");
    }
    if (!isSocialAccountId(socialAccountId)) {
      throw new BadRequestException("Invalid social account id");
    }
    const now = new Date();
    const res = await this.connection.collection(collection).updateOne(
      {
        _id: new Types.ObjectId(userId),
        "socialMedia.socialAccountId": socialAccountId,
      },
      { $set: { "socialMedia.$.contentTypes.$[].priceConfirmedAt": now } },
    );
    if (!res.matchedCount)
      throw new NotFoundException("Social account not found");
    return { confirmedAt: now };
  }
}
