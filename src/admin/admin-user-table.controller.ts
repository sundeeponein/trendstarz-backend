import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Query,
  Req,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";

type BrandImageDoc = {
  brandLogo?: any[];
  products?: any[];
  promotionalPrice?: number;
  price?: number;
  save: () => Promise<unknown>;
};

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminUserTableController {
  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<BrandImageDoc>,
    @InjectModel("Payment") private readonly paymentModel: Model<Payment>,
  ) {}

  private normalizeAdminTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return Array.from(
      new Set(
        tags.map((tag) => String(tag || "").trim()).filter((tag) => !!tag),
      ),
    );
  }

  @Get("influencers")
  async getInfluencers(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("category") category?: string,
  ) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = { $in: [true, "true"] };
    } else {
      filter.isDeleted = { $nin: [true, "true"] };
    }
    if (q) filter.q = q;
    if (category) filter.category = category;
    const influencers = await this.influencerModel
      .find(filter)
      .lean()
      .limit(100);
    await Promise.all(
      influencers.map(async (u) => {
        // Fetch latest approved payment
        u.latestPayment = await this.paymentModel
          .findOne({ userId: u._id, status: "approved" })
          .sort({ approvedAt: -1 })
          .lean();
      }),
    );
    return influencers;
  }

  @Get("brands")
  async getBrands(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("category") category?: string,
  ) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = { $in: [true, "true"] };
    } else {
      filter.isDeleted = { $nin: [true, "true"] };
    }
    if (q) filter.q = q;
    if (category) filter.category = category;
    const brands = await this.brandModel.find(filter).lean().limit(100);
    await Promise.all(
      brands.map(async (b) => {
        if (!b.brandLogo) b.brandLogo = [];
        if (!b.products) b.products = [];
        if (
          b.promotionalPrice === undefined &&
          (b as any).price !== undefined
        ) {
          b.promotionalPrice = (b as any).price;
        }
        // Fetch latest approved payment
        (b as any).latestPayment = await this.paymentModel
          .findOne({ userId: b._id, status: "approved" })
          .sort({ approvedAt: -1 })
          .lean();
      }),
    );
    return brands;
  }

  @Patch("users/:type/:id/tags")
  async patchUserTags(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body() body: { adminTags?: string[] },
  ) {
    const normalizedType = String(type || "").toLowerCase();
    const adminTags = this.normalizeAdminTags(body?.adminTags);
    if (normalizedType !== "influencer" && normalizedType !== "brand") {
      return { message: "Unsupported user type", type, id };
    }

    const update = { $set: { adminTags } };
    const user =
      normalizedType === "influencer"
        ? await this.influencerModel
            .findByIdAndUpdate(id, update, { new: true })
            .exec()
        : await this.brandModel
            .findByIdAndUpdate(id, update, { new: true })
            .exec();

    if (!user) {
      return { message: "User not found", type, id };
    }

    return { message: "User tags updated", user };
  }

  @Patch("users/influencer/:id/verification")
  async updateInfluencerVerification(
    @Param("id") id: string,
    @Body()
    body: {
      action?: "pending" | "approve" | "reject" | "remove";
      notes?: string;
    },
    @Req() req: any,
  ) {
    const influencer = await this.influencerModel.findById(id);
    if (!influencer) {
      return { message: "Influencer not found", id };
    }

    const action = String(body?.action || "").toLowerCase();
    const notes = String(body?.notes || "").trim();
    const actorId = String(req?.user?.userId || req?.user?.id || "admin");
    const actorRole = String(req?.user?.role || "admin");

    let status = influencer.verificationStatus || "not_submitted";
    if (action === "approve") status = "approved";
    else if (action === "reject") status = "rejected";
    else if (action === "remove") status = "removed";
    else if (action === "pending") status = "pending";

    influencer.verificationStatus = status;
    influencer.verifiedByTrendStarz = status === "approved";
    influencer.verificationAdminNotes = notes;

    const log = Array.isArray(influencer.verificationAuditLog)
      ? influencer.verificationAuditLog
      : [];
    log.push({
      action:
        action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : action === "remove"
              ? "removed"
              : notes
                ? "notes_updated"
                : "status_changed",
      status,
      note: notes,
      actorId,
      actorRole,
      actedAt: new Date(),
    });
    influencer.verificationAuditLog = log.slice(-100);

    const saved = await influencer.save();
    return { message: "Verification updated", user: saved };
  }

  @Patch("users/brand/:id/verification")
  async updateBrandVerification(
    @Param("id") id: string,
    @Body()
    body: {
      verifiedByTrendStarz?: boolean;
      adminTags?: string[];
    },
  ) {
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }

    if (typeof body?.verifiedByTrendStarz === "boolean") {
      (brand as any).verifiedByTrendStarz = !!body.verifiedByTrendStarz;
    }

    if (Array.isArray(body?.adminTags)) {
      (brand as any).adminTags = this.normalizeAdminTags(body.adminTags);
    }

    const saved = await (brand as any).save();
    return { message: "Brand verification updated", user: saved };
  }

  @Patch("users/:type/:id/contact-verification")
  async updateContactVerification(
    @Param("type") type: string,
    @Param("id") id: string,
    @Body()
    body: {
      isEmailVerified?: boolean;
      isMobileVerified?: boolean;
    },
  ) {
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedType !== "influencer" && normalizedType !== "brand") {
      return { message: "Unsupported user type", type, id };
    }

    const user =
      normalizedType === "influencer"
        ? await this.influencerModel.findById(id)
        : await this.brandModel.findById(id);

    if (!user) {
      return { message: "User not found", type, id };
    }

    const hasEmail = typeof body?.isEmailVerified === "boolean";
    const hasMobile = typeof body?.isMobileVerified === "boolean";
    if (!hasEmail && !hasMobile) {
      return { message: "No verification fields provided", type, id };
    }

    if (hasEmail) {
      user.isEmailVerified = !!body.isEmailVerified;
    }
    if (hasMobile) {
      user.isMobileVerified = !!body.isMobileVerified;
    }

    const saved = await user.save();
    return { message: "Contact verification updated", user: saved };
  }

  // PATCH endpoint to directly update brandLogo and products for a brand
  @Patch("brands/:id/images")
  async patchBrandImages(
    @Param("id") id: string,
    @Body() body: { brandLogo?: any[]; products?: any[] },
  ) {
    const brand = await this.brandModel.findById(id);
    if (!brand) {
      return { message: "Brand not found", id };
    }
    if (body.brandLogo) {
      brand.brandLogo = body.brandLogo;
    }
    if (body.products) {
      brand.products = body.products;
    }
    await brand.save();
    return { message: "Brand images updated", brand };
  }
}
