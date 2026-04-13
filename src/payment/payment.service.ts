import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";
import { PlansService } from "../plans/plans.service";

@Injectable()
export class PaymentService {
  constructor(
    @InjectModel("Payment") private readonly paymentModel: Model<Payment>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    public readonly plansService: PlansService,
  ) {}

  /**
   * Get recent payments for a user (all statuses)
   */
  async getPaymentsByUser(userId: string, limit = 5) {
    const payments = await this.paymentModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { success: true, payments };
  }

  async confirmUpgrade(userId: string, premiumDuration: "1m" | "3m" | "1y") {
    const update: any = { isPremium: true, premiumDuration };
    const now = new Date();
    update.premiumStart = now;
    const end = new Date(now);
    if (premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
    else if (premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
    else if (premiumDuration === "1y") end.setFullYear(end.getFullYear() + 1);
    update.premiumEnd = end;

    const influencer = await this.influencerModel.findByIdAndUpdate(
      userId,
      update,
      {
        new: true,
      },
    );
    if (influencer)
      return { success: true, message: "Premium activated", premiumEnd: end };
    const brand = await this.brandModel.findByIdAndUpdate(userId, update, {
      new: true,
    });
    if (brand)
      return { success: true, message: "Premium activated", premiumEnd: end };
    return { success: false, message: "User not found" };
  }

  /* ── Manual UPI Payment Flow ─────────────────────── */

  async createPendingPayment(
    userId: string,
    transactionId: string,
    amount: number,
    premiumDuration: "1m" | "3m" | "1y",
    paymentMethod: "upi" | "qr" = "upi",
    userType: "Influencer" | "Brand" = "Influencer",
  ) {
    // Check if transaction ID already exists
    const existing = await this.paymentModel.findOne({ transactionId });
    if (existing) {
      return {
        success: false,
        message: "Transaction ID already used. Please verify and try again.",
      };
    }

    // Fetch user and store snapshot
    let user;
    if (userType === "Influencer") {
      user = await this.influencerModel.findById(userId).lean();
    } else {
      user = await this.brandModel.findById(userId).lean();
    }
    let userSnapshot = {};
    if (user && typeof user === "object" && !Array.isArray(user)) {
      userSnapshot = {
        name: (user as any).name || (user as any).brandName,
        email: (user as any).email,
      };
    }

    // Create approved payment record instantly
    const payment = new this.paymentModel({
      userId,
      userType,
      userSnapshot,
      transactionId,
      amount,
      premiumDuration,
      paymentMethod,
      status: "approved",
      approvedAt: new Date(),
    });

    await payment.save();

    // Instantly upgrade user and activate subscription
    await this.confirmUpgrade(userId, premiumDuration);
    try {
      const plan = await this.plansService.findProPlanForUserType(userType);
      await this.plansService.activateSubscription(
        String(userId),
        userType,
        String(plan._id),
        premiumDuration,
      );
    } catch (e) {
      // Non-fatal: subscription creation failed but payment is approved
      console.error(
        "[Payment][AutoApproval] subscription activation failed",
        e,
      );
    }

    return {
      success: true,
      message: "Payment successful. Premium activated.",
      paymentId: payment._id,
    };
  }

  async getPendingPayments(page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const payments = await this.paymentModel
      .find({ status: "pending" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        "userId",
        "username brandUsername email name brandName profileImages brandLogo phoneNumber categories location",
      );

    const total = await this.paymentModel.countDocuments({
      status: "pending",
    });

    return {
      success: true,
      payments,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  // approvePayment is now obsolete (instant approval)

  async rejectPayment(paymentId: string, rejectionReason: string) {
    const payment = await this.paymentModel.findById(paymentId);
    if (!payment) return { success: false, message: "Payment not found" };
    if (payment.status !== "pending") {
      return { success: false, message: "Payment is not pending" };
    }

    payment.status = "rejected";
    payment.approvalNotes = rejectionReason;
    await payment.save();

    return { success: true, message: "Payment rejected." };
  }

  async getPaymentsByStatus(
    status: "approved" | "rejected" | "pending",
    page = 1,
    limit = 50,
  ) {
    const skip = (page - 1) * limit;
    const payments = await this.paymentModel
      .find({ status })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        "userId",
        "username brandUsername email name brandName profileImages brandLogo phoneNumber categories location",
      )
      .lean();
    return { success: true, payments };
  }

  async getPaymentById(paymentId: string) {
    const payment = await this.paymentModel
      .findById(paymentId)
      .populate(
        "userId",
        "username brandUsername email name brandName profileImages brandLogo phoneNumber categories location",
      );
    return { success: true, payment };
  }
}
