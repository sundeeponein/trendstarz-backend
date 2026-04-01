import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  InfluencerModel,
  BrandModel,
} from "../database/schemas/profile.schemas";
import { Payment } from "../database/schemas/payment.schema";

@Injectable()
export class PaymentService {
  constructor(
    @InjectModel("Payment") private readonly paymentModel: Model<Payment>,
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

    const influencer = await InfluencerModel.findByIdAndUpdate(userId, update, {
      new: true,
    });
    if (influencer)
      return { success: true, message: "Premium activated", premiumEnd: end };
    const brand = await BrandModel.findByIdAndUpdate(userId, update, {
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

    // Create pending payment record
    const payment = new this.paymentModel({
      userId,
      userType,
      transactionId,
      amount,
      premiumDuration,
      paymentMethod,
      status: "pending",
    });

    await payment.save();
    return {
      success: true,
      message: "Payment recorded. Awaiting admin approval.",
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
      .populate("userId", "username brandUsername email name brandName");

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

  async approvePayment(paymentId: string, adminId: string) {
    const payment = await this.paymentModel.findById(paymentId);
    if (!payment) return { success: false, message: "Payment not found" };
    if (payment.status !== "pending") {
      return { success: false, message: "Payment is not pending" };
    }

    // Upgrade user to premium
    const now = new Date();
    const end = new Date(now);
    if (payment.premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
    else if (payment.premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
    else if (payment.premiumDuration === "1y")
      end.setFullYear(end.getFullYear() + 1);

    let upgraded = false;
    if (payment.userType === "Influencer") {
      const result = await InfluencerModel.findByIdAndUpdate(
        payment.userId,
        {
          isPremium: true,
          premiumDuration: payment.premiumDuration,
          premiumStart: now,
          premiumEnd: end,
        },
        { new: true },
      );
      if (result) upgraded = true;
    } else {
      const result = await BrandModel.findByIdAndUpdate(
        payment.userId,
        {
          isPremium: true,
          premiumDuration: payment.premiumDuration,
          premiumStart: now,
          premiumEnd: end,
        },
        { new: true },
      );
      if (result) upgraded = true;
    }

    if (!upgraded) {
      return { success: false, message: "User not found" };
    }

    // Mark payment as approved
    payment.status = "approved";
    payment.approvedBy = adminId as any;
    payment.approvedAt = new Date();
    await payment.save();

    return {
      success: true,
      message: "Payment approved. User upgraded to premium.",
    };
  }

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
      .populate("userId", "username brandUsername email name brandName")
      .lean();
    return { success: true, payments };
  }

  async getPaymentById(paymentId: string) {
    const payment = await this.paymentModel
      .findById(paymentId)
      .populate("userId", "username brandUsername email name brandName");
    return { success: true, payment };
  }
}
