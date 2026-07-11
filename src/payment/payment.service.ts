import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "../database/schemas/payment.schema";
import { PlansService } from "../plans/plans.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";

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
    amount: number,
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
      amount,
      premiumDuration,
      paymentMethod,
      status: "pending",
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
    const payment = await this.paymentModel.findById(paymentId);
    if (!payment) return { success: false, message: "Payment not found" };
    if (payment.status !== "pending") {
      return { success: false, message: "Payment is not pending" };
    }
    payment.status = "approved";
    payment.approvedBy = adminId;
    payment.approvedAt = new Date();
    await payment.save();

    // Activate premium for user
    await this.confirmUpgrade(payment.userId, payment.premiumDuration);
    await this.recordPremiumConversion(String(payment.userId), payment.amount, payment._id);
    try {
      const plan = await this.plansService.findProPlanForUserType(payment.userType);
      await this.plansService.activateSubscription(
        String(payment.userId),
        payment.userType,
        String(plan._id),
        payment.premiumDuration,
      );
    } catch (e) {
      // Non-fatal: subscription creation failed but payment is approved
      console.error(
        "[Payment][ManualApproval] subscription activation failed",
        e,
      );
    }

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
    payment.refundAmount = Number(payment.amount || 0);
    payment.refundReason = reason || "Refund marked by admin";
    payment.approvalNotes = payment.approvalNotes
      ? `${payment.approvalNotes}\nRefund: ${payment.refundReason}`
      : `Refund: ${payment.refundReason}`;
    await payment.save();

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

  async getAdminSummary() {
    const rows = await this.paymentModel
      .find({ ...this.subscriptionPurposeFilter() })
      .select("amount status refundStatus paymentStatus gatewayProvider paymentMethod")
      .lean();

    const amountInRupees = (row: any) => {
      const amount = Number(row?.amount || 0);
      return row?.gatewayProvider === "razorpay" || row?.paymentMethod === "razorpay"
        ? amount / 100
        : amount;
    };

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
