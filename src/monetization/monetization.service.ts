import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as crypto from "crypto";
import { RazorpayService } from "../payment/razorpay.service";
import { PaymentService } from "../payment/payment.service";
import { PlansService } from "../plans/plans.service";
import { CampaignInvitesService } from "../campaigns/campaign-invites.service";
import { paymentAmountPaise } from "../payment/payment-amount.util";
import {
  assertDisplayedPriceMatches,
  computeSubscriptionPrice,
  SubscriptionPrice,
} from "../plans/subscription-price.util";
import { effectiveGstPercent } from "../payments-payouts/fee-rates.util";

type UserRole = "brand" | "influencer" | "photographer";

function toObjectId(value: string) {
  return new Types.ObjectId(value);
}

function toDayKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

@Injectable()
export class MonetizationService {
  constructor(
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("Payment") private readonly paymentModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Transaction") private readonly transactionModel: Model<any>,
    @InjectModel("CollaborationUnlock") private readonly unlockModel: Model<any>,
    @InjectModel("UsageCounter") private readonly usageModel: Model<any>,
    @InjectModel("SocialProfileClick") private readonly socialClickModel: Model<any>,
    @InjectModel("LinkConversion") private readonly linkConversionModel: Model<any>,
    private readonly razorpayService: RazorpayService,
    private readonly paymentService: PaymentService,
    private readonly plansService: PlansService,
    private readonly invitesService: CampaignInvitesService,
  ) {}

  async getFeeSettings() {
    const settings =
      (await this.appSettingsModel.findOne().lean()) ||
      (await this.appSettingsModel.create({}));

    return {
      success: true,
      feeSettings: {
        platformFeePercent: Number(settings?.platformFeePercent ?? 5),
        inviteUnlockFee: Number(settings?.inviteUnlockFee ?? 499),
        minimumCampaignFee: Number(settings?.minimumCampaignFee ?? 1000),
        // Never GST without a GSTIN (same rule as campaign payments).
        gstPercent: effectiveGstPercent(settings),
        platformCommissionPercent: Number(settings?.platformCommissionPercent ?? 12),
      },
    };
  }

  async updateFeeSettings(payload: any) {
    const patch: any = {};
    const allowed = [
      "platformFeePercent",
      "inviteUnlockFee",
      "minimumCampaignFee",
      "gstPercent",
      "platformCommissionPercent",
    ];

    for (const key of allowed) {
      if (payload?.[key] !== undefined) {
        patch[key] = Number(payload[key]);
      }
    }

    if (patch.minimumCampaignFee !== undefined && patch.minimumCampaignFee < 0) {
      throw new BadRequestException("minimumCampaignFee must be >= 0");
    }

    await this.appSettingsModel.updateOne({}, { $set: patch }, { upsert: true });
    return this.getFeeSettings();
  }

  async createSubscriptionOrder(input: {
    userId: string;
    userRole: UserRole;
    planId: string;
    billingCycle: "monthly" | "quarterly" | "yearly";
    couponCode?: string;
    // The total the page showed — checked against the server price, never charged.
    finalAmount?: number;
  }) {
    const plan: any = await this.plansService.planModel.findById(input.planId).lean();
    if (!plan) throw new NotFoundException("Plan not found");
    // The plan must be for the buyer's own account type (its price differs per role).
    if (String(plan.userType || "").toUpperCase() !== String(input.userRole || "").toUpperCase()) {
      throw new BadRequestException("This plan is not available for your account type.");
    }

    const premiumDuration =
      input.billingCycle === "yearly"
        ? "1y"
        : input.billingCycle === "quarterly"
          ? "3m"
          : "1m";
    let price: SubscriptionPrice;
    try {
      price = computeSubscriptionPrice(plan, input.billingCycle, input.couponCode);
      assertDisplayedPriceMatches(input.finalAmount, price);
    } catch (e: any) {
      throw new BadRequestException(e?.message || "Invalid price");
    }
    if (price.baseRupees <= 0 || price.finalRupees <= 0) {
      throw new BadRequestException("Invalid plan amount");
    }
    const amount = price.finalRupees;
    const amountPaise = amount * 100;

    // Retrying/refreshing the payment page calls this again — drop any earlier pending
    // razorpay order for this user's subscription so it doesn't pile up as orphaned
    // "pending" rows (razorpay payments are auto-verified, never manually reviewed).
    await this.paymentModel.deleteMany({
      userId: toObjectId(input.userId),
      purpose: "subscription",
      paymentMethod: "razorpay",
      status: "pending",
    });

    const order = await this.razorpayService.createOrder(amountPaise, {
      userId: input.userId,
      premiumDuration,
    });

    const payment = await this.paymentModel.create({
      userId: toObjectId(input.userId),
      userType: input.userRole === "brand" ? "Brand" : input.userRole === "photographer" ? "Photographer" : "Influencer",
      transactionId: `rzp_sub_${Date.now()}`,
      amount: amountPaise,
      amountPaise,
      premiumDuration,
      status: "pending",
      paymentMethod: "razorpay",
      gatewayProvider: "razorpay",
      purpose: "subscription",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        planId: input.planId,
        billingCycle: input.billingCycle,
        baseAmountPaise: price.baseRupees * 100,
        discountPaise: price.discountRupees * 100,
        discountPercent: price.discountPercent,
        discountSource: price.discountSource,
        couponCode: price.couponCode,
      },
    });

    await this.transactionModel.create({
      userId: toObjectId(input.userId),
      userRole: input.userRole,
      type: "subscription_payment",
      relatedId: String(payment._id),
      amount,
      paymentProvider: "razorpay",
      orderId: order.orderId,
      paymentStatus: "created",
      netAmount: amount,
      logs: [{ event: "order_created", payload: { planId: input.planId } }],
    });

    return {
      success: true,
      order,
      paymentId: payment._id,
    };
  }

  async createInviteUnlockOrder(input: {
    inviteId: string;
    payerId: string;
    payerRole: UserRole;
  }) {
    const invite: any = await this.inviteModel.findById(input.inviteId).lean();
    if (!invite) throw new NotFoundException("Invite not found");

    if (!["accepted", "payment_confirmed", "working", "submitted", "completed"].includes(String(invite.status || ""))) {
      throw new BadRequestException("Invite must be accepted before unlock payment.");
    }

    const campaign: any = await this.campaignModel.findById(invite.campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");

    const settingsRes = await this.getFeeSettings();
    const feeSettings = settingsRes.feeSettings;
    const campaignType = String(campaign?.campaignType || "");
    if (campaignType === "invite_location") {
      throw new BadRequestException(
        "Invite to Location does not require unlock payment. Contact and venue details unlock after acceptance.",
      );
    }
    const isPaidCampaign = campaignType === "paid_collab";
    const amount = isPaidCampaign
      ? Math.max(Number(campaign?.pricePerInfluencer || 0), feeSettings.minimumCampaignFee)
      : feeSettings.inviteUnlockFee;

    const commissionPercent = feeSettings.platformCommissionPercent;
    const gstPercent = feeSettings.gstPercent;
    const commissionAmount = Number(((amount * commissionPercent) / 100).toFixed(2));
    const gstAmount = Number(((amount * gstPercent) / 100).toFixed(2));
    const grossAmount = Number((amount + commissionAmount + gstAmount).toFixed(2));

    const order = await this.razorpayService.createOrder(Math.round(grossAmount * 100), {
      userId: input.payerId,
      premiumDuration: "1m",
    });

    const payment = await this.paymentModel.create({
      userId: toObjectId(input.payerId),
      userType: input.payerRole === "brand" ? "Brand" : input.payerRole === "photographer" ? "Photographer" : "Influencer",
      transactionId: `rzp_unlock_${Date.now()}`,
      amount: Math.round(grossAmount * 100),
      amountPaise: Math.round(grossAmount * 100),
      premiumDuration: "1m",
      status: "pending",
      paymentMethod: "razorpay",
      gatewayProvider: "razorpay",
      purpose: "invite_unlock",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        inviteId: input.inviteId,
        campaignId: String(invite.campaignId),
      },
      feeBreakdown: {
        baseAmount: amount,
        commissionPercent,
        commissionAmount,
        gstPercent,
        gstAmount,
        totalAmount: grossAmount,
      },
    });

    const tx = await this.transactionModel.create({
      userId: toObjectId(input.payerId),
      userRole: input.payerRole,
      type: "invite_unlock_payment",
      relatedId: String(input.inviteId),
      amount: grossAmount,
      commissionAmount,
      gstAmount,
      netAmount: amount,
      paymentProvider: "razorpay",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        inviteId: input.inviteId,
        campaignId: String(invite.campaignId),
      },
      logs: [{ event: "order_created", payload: { inviteId: input.inviteId } }],
    });

    const recipientId = String(invite.influencerId);
    const recipientRole = String(invite.recipientRole || "influencer") as UserRole;
    await this.unlockModel.updateOne(
      { inviteId: toObjectId(input.inviteId), payerId: toObjectId(input.payerId) },
      {
        $set: {
          campaignId: toObjectId(String(invite.campaignId)),
          payerRole: input.payerRole,
          recipientId: toObjectId(recipientId),
          recipientRole,
          collaborationType: this.mapCampaignType(campaign?.campaignType),
          unlockKind: isPaidCampaign ? "paid_campaign_payment" : "coordination_unlock_fee",
          amount: grossAmount,
          platformCommissionPercent: commissionPercent,
          gstPercent,
          status: "pending",
          paymentStatus: "created",
          paymentId: payment._id,
          transactionId: tx._id,
        },
      },
      { upsert: true },
    );

    return {
      success: true,
      order,
      unlock: {
        inviteId: input.inviteId,
        amount: grossAmount,
        commissionAmount,
        gstAmount,
      },
    };
  }

  async verifyRazorpayPayment(input: {
    orderId: string;
    paymentId: string;
    signature: string;
    paymentType: "subscription" | "invite_unlock";
    userId: string;
  }) {
    const valid = this.razorpayService.verifySignature(
      input.orderId,
      input.paymentId,
      input.signature,
    );

    if (!valid) {
      throw new BadRequestException("Invalid payment signature");
    }
    return this.completePaidOrder({
      orderId: input.orderId,
      paymentId: input.paymentId,
      signature: input.signature,
      purpose: input.paymentType === "subscription" ? "subscription" : "invite_unlock",
      userId: input.userId,
    });
  }

  /**
   * An order Razorpay confirmed as paid → activate what it bought. Called by the
   * checkout callback (signature checked, userId from the session) and by the
   * Razorpay webhook (when the browser never came back). Runs once per order.
   */
  async completePaidOrder(input: {
    orderId: string;
    paymentId: string;
    signature?: string | null;
    purpose: "subscription" | "invite_unlock";
    userId?: string;
  }) {
    const orderFilter: Record<string, unknown> = {
      orderId: input.orderId,
      purpose: input.purpose,
      ...(input.userId ? { userId: toObjectId(input.userId) } : {}),
    };
    // Claim the order once: the checkout callback and a page refresh can both
    // verify the same payment — only the first may activate Premium/unlock.
    const payment: any = await this.paymentModel
      .findOneAndUpdate(
        { ...orderFilter, status: { $ne: "approved" } },
        {
          $set: {
            paymentId: input.paymentId,
            paymentStatus: "captured",
            status: "approved",
            gatewayVerifiedAt: new Date(),
            ...(input.signature ? { gatewaySignature: input.signature } : {}),
            gatewayProvider: "razorpay",
          },
        },
        { new: true },
      )
      .lean();
    if (!payment) {
      const existing: any = await this.paymentModel.findOne(orderFilter).lean();
      if (!existing) throw new NotFoundException("Payment order not found");
      // Already verified (by the other request) — nothing more to do.
      return { success: true, paymentId: existing.paymentId || input.paymentId };
    }
    const userId = String(payment.userId);

    await this.transactionModel.updateMany(
      { orderId: input.orderId },
      {
        $set: { paymentId: input.paymentId, paymentStatus: "captured" },
        $push: {
          logs: {
            at: new Date(),
            event: "payment_captured",
            payload: { orderId: input.orderId },
          },
        },
      },
    );

    if (input.purpose === "invite_unlock") {
      const inviteId = String(payment?.metadata?.inviteId || "").trim();
      if (inviteId) {
        await this.unlockModel.updateOne(
          { inviteId: toObjectId(inviteId) },
          {
            $set: {
              status: "paid",
              paymentStatus: "captured",
              unlockedAt: new Date(),
            },
          },
        );
        const payerRole = String(payment?.userType || "").toLowerCase();
        if (payerRole === "brand") {
          await this.invitesService.unlockContact(inviteId, userId);
        } else {
          await this.inviteModel.findByIdAndUpdate(inviteId, {
            $set: {
              unlocked: true,
              unlockedAt: new Date(),
              unlockType: "premium",
            },
          });
        }
      }
    }

    if (input.purpose === "subscription") {
      const planId = String(payment?.metadata?.planId || "").trim();
      const billingCycle = String(payment?.metadata?.billingCycle || "monthly");
      const paymentUserType = String(payment?.userType || "Influencer");
      const normalizedUserType =
        paymentUserType === "Brand"
          ? "Brand"
          : paymentUserType === "Photographer"
            ? "Photographer"
            : "Influencer";
      const premiumDuration =
        billingCycle === "yearly" ? "1y" : billingCycle === "quarterly" ? "3m" : "1m";
      let subscriptionEnd: Date | null = null;
      if (planId) {
        const sub: any = await this.plansService.activateSubscription(
          userId,
          normalizedUserType,
          planId,
          premiumDuration,
          "payment",
        );
        subscriptionEnd = sub?.endDate ?? null;
      }
      // Mirror the subscription onto the user's own profile doc — isPremium there
      // (not the subscriptions collection) drives the Pro badge and visibility
      // gating — with the subscription's exact end date (bonus months included).
      await this.paymentService.confirmUpgrade(userId, premiumDuration, subscriptionEnd);
      await this.recordPremiumConversion(userId, paymentAmountPaise(payment), payment._id);
    }

    return { success: true, paymentId: input.paymentId };
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

  async trackSocialClick(input: {
    actorUserId: string;
    actorRole: UserRole;
    targetUserId: string;
    targetRole: UserRole;
    platform: string;
    url: string;
    source?: string;
    userAgent?: string;
    ip?: string;
  }) {
    const ipHash = input.ip
      ? crypto.createHash("sha256").update(String(input.ip)).digest("hex")
      : "";

    const doc = await this.socialClickModel.create({
      actorUserId: toObjectId(input.actorUserId),
      actorRole: input.actorRole,
      targetUserId: toObjectId(input.targetUserId),
      targetRole: input.targetRole,
      platform: String(input.platform || "").toLowerCase(),
      url: input.url,
      source: input.source || "profile",
      day: toDayKey(),
      userAgent: input.userAgent || "",
      ipHash,
    });

    return { success: true, clickId: doc._id };
  }

  async getUsageSummary(userId: string, userRole: UserRole) {
    const day = toDayKey();
    const [search, profileView, caps] = await Promise.all<any>([
      this.usageModel.findOne({ userId, userRole, usageType: "search", day }).lean(),
      this.usageModel.findOne({ userId, userRole, usageType: "profile_view", day }).lean(),
      this.plansService.getUserPlanCapabilities(userId),
    ]);

    const searchLimit = Number(
      (caps?.limits || []).find((l: any) => l?.key === "dailySearchLimit")?.value || 0,
    );
    const profileLimit = Number(
      (caps?.limits || []).find((l: any) => l?.key === "dailyProfileViewLimit")?.value || 0,
    );

    return {
      success: true,
      usage: {
        day,
        search: {
          used: Number(search?.used || 0),
          limit: searchLimit,
          remaining: Math.max(searchLimit - Number(search?.used || 0), 0),
        },
        profileViews: {
          used: Number(profileView?.used || 0),
          limit: profileLimit,
          remaining: Math.max(profileLimit - Number(profileView?.used || 0), 0),
        },
      },
    };
  }

  async adminRevenueSummary(days = 30) {
    const since = new Date(Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000);

    const [totals, byType, premiumUsers, activeUnlocks] = await Promise.all([
      this.transactionModel.aggregate([
        { $match: { createdAt: { $gte: since }, paymentStatus: "captured" } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amount" },
            commission: { $sum: "$commissionAmount" },
            gst: { $sum: "$gstAmount" },
          },
        },
      ]),
      this.transactionModel.aggregate([
        { $match: { createdAt: { $gte: since }, paymentStatus: "captured" } },
        { $group: { _id: "$type", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      this.plansService.subscriptionModel.countDocuments({ status: "active" }),
      this.unlockModel.countDocuments({ status: "paid" }),
    ]);

    return {
      success: true,
      summary: {
        from: since,
        to: new Date(),
        totalRevenue: Number(totals?.[0]?.revenue || 0),
        totalCommission: Number(totals?.[0]?.commission || 0),
        totalGst: Number(totals?.[0]?.gst || 0),
        premiumUsers,
        activeUnlocks,
        revenueByType: byType,
      },
    };
  }

  private mapCampaignType(type: string):
    | "paid_campaign"
    | "product_collaboration"
    | "event_invite"
    | "reels_ugc_collaboration"
    | "photoshoot_collaboration" {
    const normalized = String(type || "").toLowerCase();
    if (normalized === "paid_collab") return "paid_campaign";
    if (normalized === "product") return "product_collaboration";
    if (normalized === "invite_location") return "event_invite";
    if (normalized === "reels_ugc") return "reels_ugc_collaboration";
    return "photoshoot_collaboration";
  }
}
