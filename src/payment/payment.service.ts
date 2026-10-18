import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";
import { PlansService } from "../plans/plans.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";
import { paymentAmountPaise, paymentAmountRupees } from "./payment-amount.util";
import { SubscriptionPrice } from "../plans/subscription-price.util";

@Injectable()
export class PaymentService {
  constructor(
    @InjectModel("Payment") private readonly paymentModel: Model<Payment>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("LinkConversion") private readonly linkConversionModel: Model<any>,
    public readonly plansService: PlansService,
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  private subscriptionPurposeFilter() {
    // Keep legacy rows (created before `purpose` existed) visible as subscription history.
    return {
      $or: [{ purpose: "subscription" }, { purpose: { $exists: false } }],
    };
  }

  private userModelForType(userType: string) {
    const normalized = String(userType || "").toLowerCase();
    if (normalized === "brand") return this.brandModel;
    if (normalized === "photographer") return this.photographerModel;
    return this.influencerModel;
  }

  /**
   * Get recent payments for a user (all statuses)
   */
  async getPaymentsByUser(userId: string, limit = 5) {
    const payments = await this.paymentModel
      .find({ userId, ...this.subscriptionPurposeFilter() })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { success: true, payments };
  }

  /**
   * Marks the profile Premium. Pass the subscription's endDate so the profile ends
   * exactly when the subscription does (bonus/Founder months and early renewals
   * included); without it the end is today + duration (fallback only).
   */
  async confirmUpgrade(
    userId: string,
    premiumDuration: "1m" | "3m" | "1y",
    endDate?: Date | null,
  ) {
    const update: any = { isPremium: true, premiumDuration, premiumSource: "payment" };
    const now = new Date();
    update.premiumStart = now;
    let end = new Date(now);
    if (premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
    else if (premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
    else if (premiumDuration === "1y") end.setFullYear(end.getFullYear() + 1);
    if (endDate && !Number.isNaN(new Date(endDate).getTime())) end = new Date(endDate);
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
    const photographer = await this.photographerModel.findByIdAndUpdate(
      userId,
      update,
      {
        new: true,
      },
    );
    if (photographer)
      return { success: true, message: "Premium activated", premiumEnd: end };
    return { success: false, message: "User not found" };
  }

  // Best-effort: if this user originally joined through a referral tracking link,
  // record that they've now converted to a paying Premium subscriber. Never blocks payment.
  private async recordPremiumConversion(userId: string, amount: number, paymentId: any): Promise<void> {
    try {
      const signup: any = await this.linkConversionModel
        .findOne({ userId: String(userId), conversionType: "signup" })
        .lean();
      if (!signup) return;
      await this.linkConversionModel.updateOne(
        { trackingLinkId: signup.trackingLinkId, userId: signup.userId, conversionType: "premium_purchase" },
        {
          $setOnInsert: {
            trackingLinkId: signup.trackingLinkId,
            userId: signup.userId,
            userType: signup.userType,
            conversionType: "premium_purchase",
            amount,
            paymentId,
            convertedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error("Failed to record premium purchase conversion:", err);
    }
  }

  /* ── Manual UPI Payment Flow ─────────────────────── */

  async createPendingPayment(
    userId: string,
    transactionId: string,
    price: SubscriptionPrice,
    premiumDuration: "1m" | "3m" | "1y",
    paymentMethod: "upi" | "qr" = "upi",
    userType: "Influencer" | "Brand" | "Photographer" = "Influencer",
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
    } else if (userType === "Brand") {
      user = await this.brandModel.findById(userId).lean();
    } else {
      user = await this.photographerModel.findById(userId).lean();
    }
    let userSnapshot = {};
    if (user && typeof user === "object" && !Array.isArray(user)) {
      userSnapshot = {
        name: (user as any).name || (user as any).brandName,
        email: (user as any).email,
      };
    }

    // Create payment with status pending
    const payment = new this.paymentModel({
      userId,
      userType,
      userSnapshot,
      transactionId,
      amount: price.finalRupees, // legacy unit for manual rows (rupees)
      amountPaise: price.finalRupees * 100,
      premiumDuration,
      paymentMethod,
      status: "pending",
      metadata: {
        baseAmountPaise: price.baseRupees * 100,
        discountPaise: price.discountRupees * 100,
        discountPercent: price.discountPercent,
        discountSource: price.discountSource,
        couponCode: price.couponCode,
      },
    });

    await payment.save();

    return {
      success: true,
      message: "Payment recorded and pending admin approval.",
      paymentId: payment._id,
    };
  }
  /**
   * Approve a pending payment, activate premium and subscription
   */
  async approvePayment(paymentId: string, adminId: string) {
    // Guarded claim: only one approval can move a payment out of "pending", so a
    // double click or two admins can't activate Premium twice.
    const payment: any = await this.paymentModel
      .findOneAndUpdate(
        { _id: paymentId, status: "pending" },
        { $set: { status: "approved", approvedBy: adminId, approvedAt: new Date() } },
        { new: true },
      )
      .lean();
    if (!payment) {
      const exists = await this.paymentModel.exists({ _id: paymentId });
      return {
        success: false,
        message: exists ? "Payment is not pending" : "Payment not found",
      };
    }

    // Activate premium: the subscription first, then the profile with the SAME end
    // date (bonus months and early renewals included).
    let subscriptionEnd: Date | null = null;
    try {
      const plan = await this.plansService.findProPlanForUserType(payment.userType);
      const sub: any = await this.plansService.activateSubscription(
        String(payment.userId),
        payment.userType,
        String(plan._id),
        payment.premiumDuration,
      );
      subscriptionEnd = sub?.endDate ?? null;
    } catch (e) {
      // Non-fatal: subscription creation failed but payment is approved
      console.error(
        "[Payment][ManualApproval] subscription activation failed",
        e,
      );
    }
    await this.confirmUpgrade(payment.userId, payment.premiumDuration, subscriptionEnd);
    await this.recordPremiumConversion(String(payment.userId), paymentAmountPaise(payment), payment._id);

    const normalizedUserType = String(payment.userType).toLowerCase();
    const userRole = normalizedUserType === "brand"
      ? "brand"
      : normalizedUserType === "photographer"
        ? "photographer"
        : "influencer";
    this.pushService
      .sendToUser(String(payment.userId), {
        title: "Payment Approved",
        body: "Your payment was approved and premium plan is now active.",
        url: "/payment-history",
      }, 'payment')
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(payment.userId),
        userRole,
        title: "Payment Approved",
        body: "Your payment was approved and premium plan is now active.",
        url: "/payment-history",
      })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, message: "Payment approved and premium activated." };
  }

  async getPendingPayments(page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const payments = await this.paymentModel
      .find({ status: "pending", ...this.subscriptionPurposeFilter() })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        "userId",
        "username brandUsername email name brandName profileImages brandLogo phoneNumber categories location",
      );

    const total = await this.paymentModel.countDocuments({
      status: "pending",
      ...this.subscriptionPurposeFilter(),
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

  /** save() guarded by doc.$where; false when the payment changed meanwhile. */
  private async saveIfStill(payment: any): Promise<boolean> {
    try {
      await payment.save();
      return true;
    } catch (err: any) {
      if (err?.name === "DocumentNotFoundError") return false;
      throw err;
    }
  }

  async rejectPayment(paymentId: string, rejectionReason: string) {
    const payment = await this.paymentModel.findById(paymentId);
    if (!payment) return { success: false, message: "Payment not found" };
    if (payment.status !== "pending") {
      return { success: false, message: "Payment is not pending" };
    }

    payment.status = "rejected";
    payment.approvalNotes = rejectionReason;
    // Lands only if still pending — an approval at the same moment wins cleanly.
    (payment as any).$where = { status: "pending" };
    if (!(await this.saveIfStill(payment))) {
      return { success: false, message: "Payment is not pending" };
    }

    return { success: true, message: "Payment rejected." };
  }

  async refundPayment(paymentId: string, adminId: string, reason: string) {
    const payment = await this.paymentModel.findById(paymentId);
    if (!payment) return { success: false, message: "Payment not found" };
    if (payment.status !== "approved") {
      return { success: false, message: "Only approved payments can be refunded" };
    }
    if (payment.refundStatus === "processed" || payment.paymentStatus === "refunded") {
      return { success: false, message: "Payment is already refunded" };
    }

    const refundedAt = new Date();
    payment.refundStatus = "processed";
    payment.paymentStatus = "refunded";
    payment.refundedBy = adminId as any;
    payment.refundedAt = refundedAt;
    payment.refundAmount = Number(payment.amount || 0); // same unit as amount (legacy)
    payment.refundReason = reason || "Refund marked by admin";
    payment.approvalNotes = payment.approvalNotes
      ? `${payment.approvalNotes}\nRefund: ${payment.refundReason}`
      : `Refund: ${payment.refundReason}`;
    // Lands only if still approved and not refunded — a double click refunds once.
    (payment as any).$where = {
      status: "approved",
      refundStatus: { $ne: "processed" },
      paymentStatus: { $ne: "refunded" },
    };
    if (!(await this.saveIfStill(payment))) {
      return { success: false, message: "Payment is already refunded" };
    }

    await this.plansService.subscriptionModel.updateMany(
      {
        userId: payment.userId,
        status: "active",
        source: "payment",
      },
      {
        $set: {
          status: "cancelled",
          endDate: refundedAt,
        },
      },
    );

    const userModel = this.userModelForType(payment.userType);
    await userModel.findByIdAndUpdate(payment.userId, {
      $set: {
        isPremium: false,
        premiumDuration: null,
        premiumStart: null,
        premiumEnd: null,
        premiumSource: null,
      },
    });

    const normalizedUserType = String(payment.userType).toLowerCase();
    const userRole = normalizedUserType === "brand"
      ? "brand"
      : normalizedUserType === "photographer"
        ? "photographer"
        : "influencer";
    this.pushService
      .sendToUser(String(payment.userId), {
        title: "Premium Payment Refunded",
        body: "Your premium payment was marked as refunded by TrendStarz support.",
        url: "/payment-history",
      }, 'payment')
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(payment.userId),
        userRole,
        title: "Premium Payment Refunded",
        body: "Your premium payment was marked as refunded by TrendStarz support.",
        url: "/payment-history",
      })
      .catch(() => {
        /* non-critical */
      });

    return { success: true, message: "Payment marked refunded and premium removed." };
  }

  async getPaymentsByStatus(
    status: "approved" | "rejected" | "pending" | "refunded",
    page = 1,
    limit = 50,
  ) {
    const skip = (page - 1) * limit;
    const statusFilter =
      status === "refunded"
        ? { refundStatus: "processed" }
        : status === "approved"
          ? { status, refundStatus: { $ne: "processed" }, paymentStatus: { $ne: "refunded" } }
          : { status };
    const payments = await this.paymentModel
      .find({ ...statusFilter, ...this.subscriptionPurposeFilter() })
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

  async getAdminSummary(since?: Date) {
    const rows = await this.paymentModel
      .find({
        ...this.subscriptionPurposeFilter(),
        ...(since ? { createdAt: { $gte: since } } : {}),
      })
      .select("amount amountPaise status refundStatus paymentStatus gatewayProvider paymentMethod")
      .lean();

    const amountInRupees = paymentAmountRupees;

    const pending = rows
      .filter((row: any) => row.status === "pending")
      .reduce((sum: number, row: any) => sum + amountInRupees(row), 0);
    const received = rows
      .filter((row: any) =>
        row.status === "approved",
      )
      .reduce((sum: number, row: any) => sum + amountInRupees(row), 0);
    const rejected = rows
      .filter((row: any) => row.status === "rejected")
      .reduce((sum: number, row: any) => sum + amountInRupees(row), 0);
    const refunded = rows
      .filter((row: any) => row.refundStatus === "processed" || row.paymentStatus === "refunded")
      .reduce((sum: number, row: any) => sum + amountInRupees(row), 0);

    return {
      success: true,
      data: {
        received,
        pending,
        rejected,
        refunded,
        netReceived: received - refunded,
      },
    };
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
